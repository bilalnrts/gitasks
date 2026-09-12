import { STATUS_DEFINITIONS, isStatusLabel } from "../tasks/statuses.js";
import { formatTaskTitle, inferTaskStatus, stripTaskStatusPrefixes } from "../tasks/parser.js";
import type { CreateIssueInput, IssueStateFilter, IssueTransition, TaskGateway, TaskIssue } from "../tasks/types.js";
import type {
  ActivityEvent,
  ChecksState,
  CombinedStatus,
  ListPage,
  MergeMethod,
  MilestoneItems,
  MilestoneSummary,
  OverviewPayload,
  OverviewSection,
  PullRequestDetail,
  PullRequestFile,
  PullRequestReference,
  PullRequestReview,
  PullRequestSummary,
  ReviewState,
  TaskDetail,
  TaskSummary,
  UserSummary,
  WorkspaceContext,
} from "../workspace/types.js";
import { AmbiguousCreateError, PartialCreateError, UserError, errorMessage } from "../utils/errors.js";
import type { CommandRunner } from "../utils/exec.js";
import { AmbiguousMilestoneCreateError, GitHubApi, GitHubApiError, expectArray, expectObject, requiredNumber, requiredString } from "./api.js";

const PAGE_SIZE = 100;
const PULL_REQUEST_FILE_LIMIT = 3000;

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function validatedGitHubUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname === "github.com" ? url.href : "";
  } catch {
    return "";
  }
}

function validatedAvatarUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "avatars.githubusercontent.com" ? url.href : "";
  } catch {
    return "";
  }
}

function userFrom(value: unknown): UserSummary | null {
  if (value === null || value === undefined) return null;
  const user = expectObject(value, "Could not read GitHub user.");
  if (typeof user.login !== "string") return null;
  return { login: user.login, avatarUrl: validatedAvatarUrl(user.avatar_url), url: validatedGitHubUrl(user.html_url) };
}

function milestoneFrom(value: unknown): MilestoneSummary | null {
  if (value === null || value === undefined) return null;
  const milestone = expectObject(value, "Could not read GitHub milestone.");
  return {
    number: requiredNumber(milestone.number, "milestone number", "Could not read GitHub milestone."),
    title: requiredString(milestone.title, "milestone title", "Could not read GitHub milestone."),
    description: optionalString(milestone.description),
    state: milestone.state === "closed" ? "closed" : "open",
    dueOn: nullableString(milestone.due_on),
    openIssues: Number.isSafeInteger(milestone.open_issues) ? milestone.open_issues as number : 0,
    closedIssues: Number.isSafeInteger(milestone.closed_issues) ? milestone.closed_issues as number : 0,
    url: optionalString(milestone.html_url),
    updatedAt: optionalString(milestone.updated_at),
  };
}

function labelsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item === null || typeof item !== "object") return [];
    const label = expectObject(item, "Could not read GitHub label.");
    return typeof label.name === "string" ? [label.name] : [];
  });
}

function issueFrom(value: unknown): TaskIssue {
  const issue = expectObject(value, "Could not read GitHub issue.");
  const number = requiredNumber(issue.number, "issue number", "Could not read GitHub issue.");
  const title = requiredString(issue.title, "issue title", "Could not read GitHub issue.");
  const state = requiredString(issue.state, "issue state", "Could not read GitHub issue.");
  const assigneeUsers = Array.isArray(issue.assignees) ? issue.assignees.map(userFrom).filter((user): user is UserSummary => user !== null) : [];
  const result: TaskIssue = {
    id: Number.isSafeInteger(issue.id) ? issue.id as number : 0,
    nodeId: optionalString(issue.node_id),
    number,
    title,
    state: state.toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN",
    labels: labelsFrom(issue.labels),
    url: optionalString(issue.html_url) || optionalString(issue.url),
    body: optionalString(issue.body),
    createdAt: optionalString(issue.created_at),
    updatedAt: optionalString(issue.updated_at),
    author: userFrom(issue.user),
    assignees: assigneeUsers.map(({ login }) => login),
    assigneeUsers,
    milestone: milestoneFrom(issue.milestone),
  };
  return result;
}

function taskFrom(issue: TaskIssue): TaskSummary {
  const status = inferTaskStatus(issue.labels, issue.title) ?? null;
  return {
    id: issue.id ?? 0,
    nodeId: issue.nodeId ?? "",
    number: issue.number,
    status,
    fullTitle: issue.title,
    title: stripTaskStatusPrefixes(issue.title),
    body: issue.body,
    state: issue.state,
    labels: issue.labels.filter((label) => !isStatusLabel(label)),
    url: issue.url,
    createdAt: issue.createdAt ?? "",
    updatedAt: issue.updatedAt ?? "",
    author: issue.author ?? null,
    assignees: issue.assigneeUsers ?? issue.assignees.map((login) => ({ login, avatarUrl: "", url: `https://github.com/${encodeURIComponent(login)}` })),
    milestone: issue.milestone ?? null,
  };
}

function reviewStateFrom(value: unknown, draft: boolean): ReviewState {
  if (draft) return "pending";
  const state = typeof value === "string" ? value.toUpperCase() : "";
  if (state === "APPROVED") return "approved";
  if (state === "CHANGES_REQUESTED") return "changes-requested";
  if (state === "REVIEW_REQUIRED") return "review-required";
  return "unknown";
}

function checksStateFrom(value: unknown): ChecksState {
  const state = typeof value === "string" ? value.toLowerCase() : "";
  if (state === "success") return "success";
  if (state === "failure" || state === "error") return "failure";
  if (state === "pending" || state === "expected") return "pending";
  if (state === "neutral") return "neutral";
  return "unknown";
}

function pullFrom(value: unknown): PullRequestSummary {
  const pull = expectObject(value, "Could not read GitHub pull request.");
  const head = expectObject(pull.head, "Could not read pull request head.");
  const base = expectObject(pull.base, "Could not read pull request base.");
  const draft = pull.draft === true;
  return {
    number: requiredNumber(pull.number, "pull request number", "Could not read GitHub pull request."),
    nodeId: optionalString(pull.node_id),
    title: requiredString(pull.title, "pull request title", "Could not read GitHub pull request."),
    body: optionalString(pull.body),
    state: pull.state === "closed" ? "closed" : "open",
    draft,
    mergedAt: nullableString(pull.merged_at),
    author: userFrom(pull.user),
    assignees: Array.isArray(pull.assignees) ? pull.assignees.map(userFrom).filter((user): user is UserSummary => user !== null) : [],
    milestone: milestoneFrom(pull.milestone),
    labels: labelsFrom(pull.labels),
    head: { ref: requiredString(head.ref, "head ref", "Could not read pull request head."), sha: requiredString(head.sha, "head SHA", "Could not read pull request head.") },
    base: { ref: requiredString(base.ref, "base ref", "Could not read pull request base."), sha: requiredString(base.sha, "base SHA", "Could not read pull request base.") },
    reviewState: reviewStateFrom(pull.review_decision, draft),
    checksState: checksStateFrom(pull.status),
    createdAt: optionalString(pull.created_at),
    updatedAt: optionalString(pull.updated_at),
    url: optionalString(pull.html_url),
  };
}

function pageOf<T>(items: T[], page: number, receivedCount = items.length): ListPage<T> {
  const hasNext = receivedCount === PAGE_SIZE;
  return { items, hasNext, complete: !hasNext, nextPage: hasNext ? page + 1 : null, knownTotal: null };
}

function relationPullFrom(value: unknown): PullRequestReference | null {
  const issue = expectObject(value, "Could not read referenced pull request.");
  if (issue.pull_request === undefined || issue.pull_request === null || typeof issue.pull_request !== "object") return null;
  const pull = expectObject(issue.pull_request, "Could not read referenced pull request.");
  return {
    number: requiredNumber(issue.number, "pull request number", "Could not read referenced pull request."),
    title: requiredString(issue.title, "pull request title", "Could not read referenced pull request."),
    state: issue.state === "closed" ? "closed" : "open",
    draft: issue.draft === true,
    mergedAt: nullableString(pull.merged_at),
    url: optionalString(issue.html_url),
  };
}

export class GitHubClient implements TaskGateway {
  private readonly api: GitHubApi;

  constructor(readonly repository: string, private readonly runner: CommandRunner) {
    this.api = new GitHubApi(repository, runner);
  }

  private path(suffix: string): string {
    return suffix.length === 0 ? `repos/${this.repository}` : `repos/${this.repository}/${suffix}`;
  }

  async ensureStatusLabels(): Promise<string[]> {
    let labels: Array<{ name: string }>;
    try {
      const output = (await this.runner("gh", ["label", "list", "--repo", this.repository, "--limit", "1000", "--json", "name"])).stdout;
      labels = JSON.parse(output) as Array<{ name: string }>;
    } catch (error) {
      throw new UserError(`Could not read repository labels.\n\n${errorMessage(error)}`);
    }
    const existing = new Set(labels.map(({ name }) => name.toLowerCase()));
    const created: string[] = [];
    for (const definition of STATUS_DEFINITIONS) {
      if (existing.has(definition.label)) continue;
      try {
        await this.runner("gh", ["label", "create", definition.label, "--repo", this.repository, "--color", definition.color, "--description", `Gitasks status: ${definition.name}`]);
      } catch (error) {
        throw new UserError(`Could not create label ${definition.label}.\n\n${errorMessage(error)}`);
      }
      created.push(definition.label);
    }
    return created;
  }

  async getContext(): Promise<WorkspaceContext> {
    const [repositoryValue, viewerValue] = await Promise.all([
      this.api.restJson(this.path(""), "Could not read repository context."),
      this.api.restJson("user", "Could not read the authenticated GitHub user."),
    ]);
    const repository = expectObject(repositoryValue, "Could not read repository context.");
    const viewer = userFrom(viewerValue);
    if (viewer === null) throw new GitHubApiError("Could not read the authenticated GitHub user.", "invalid-response", false);
    const permissions = repository.permissions === null || typeof repository.permissions !== "object"
      ? {}
      : expectObject(repository.permissions, "Could not read repository permissions.");
    const mergeMethods: MergeMethod[] = [];
    if (repository.allow_merge_commit === true) mergeMethods.push("merge");
    if (repository.allow_squash_merge === true) mergeMethods.push("squash");
    if (repository.allow_rebase_merge === true) mergeMethods.push("rebase");
    return {
      repository: this.repository,
      repositoryUrl: optionalString(repository.html_url) || `https://github.com/${this.repository}`,
      currentUser: viewer,
      capabilities: {
        issues: repository.has_issues !== false,
        pullRequests: repository.has_pull_requests !== false,
        mergeMethods,
        permissions: { push: permissions.push === true, triage: permissions.triage === true, maintain: permissions.maintain === true, admin: permissions.admin === true },
      },
    };
  }

  async listIssues(state: IssueStateFilter): Promise<TaskIssue[]> {
    const values = await this.api.allPages(this.path(`issues?state=${state}`), "Could not list GitHub issues.");
    return values.filter((value) => {
      const object = expectObject(value, "Could not list GitHub issues.");
      return object.pull_request === undefined && (state === "all" || object.state === state);
    }).map(issueFrom);
  }

  async listIssuePage(state: IssueStateFilter, page: number): Promise<ListPage<TaskSummary>> {
    const value = await this.api.restJson(this.path(`issues?state=${state}&per_page=${PAGE_SIZE}&page=${page}`), "Could not list GitHub issues.");
    const rawItems = expectArray(value, "Could not list GitHub issues.");
    const issues = rawItems.filter((item) => expectObject(item, "Could not list GitHub issues.").pull_request === undefined).map(issueFrom).map(taskFrom);
    return pageOf(issues, page, rawItems.length);
  }

  async getIssue(issueNumber: number): Promise<TaskIssue> {
    const value = await this.api.restJson(this.path(`issues/${issueNumber}`), `Could not load issue #${issueNumber}. Make sure it exists and is accessible.`);
    const object = expectObject(value, `Could not load issue #${issueNumber}.`);
    if (object.pull_request !== undefined) throw new UserError(`#${issueNumber} is a pull request, not an issue.`);
    return issueFrom(object);
  }

  async getIssueDetail(issueNumber: number): Promise<TaskDetail> {
    const task = taskFrom(await this.getIssue(issueNumber));
    const [parentValue, subValues, blockedValues, blockingValues, timelineValues] = await Promise.all([
      this.optionalRelation(this.path(`issues/${issueNumber}/parent`), `Could not load the parent of issue #${issueNumber}.`),
      this.api.allPages(this.path(`issues/${issueNumber}/sub_issues`), `Could not load sub-issues of #${issueNumber}.`, { unsupportedOnNotFound: true }),
      this.api.allPages(this.path(`issues/${issueNumber}/dependencies/blocked_by`), `Could not load blockers of #${issueNumber}.`, { unsupportedOnNotFound: true }),
      this.api.allPages(this.path(`issues/${issueNumber}/dependencies/blocking`), `Could not load issues blocked by #${issueNumber}.`, { unsupportedOnNotFound: true }),
      this.api.allPages(this.path(`issues/${issueNumber}/timeline`), `Could not load references for issue #${issueNumber}.`),
    ]);
    const linked = timelineValues.flatMap((event) => {
      const object = expectObject(event, "Could not read issue timeline.");
      if (object.event !== "cross-referenced") return [];
      if (object.source === null || typeof object.source !== "object") return [];
      const source = expectObject(object.source, "Could not read issue timeline source.").issue;
      if (source === undefined) return [];
      const pull = relationPullFrom(source);
      return pull === null ? [] : [pull];
    });
    return {
      task,
      parent: parentValue === null ? null : taskFrom(issueFrom(parentValue)),
      subIssues: subValues.map(issueFrom).map(taskFrom),
      blockedBy: blockedValues.map(issueFrom).map(taskFrom),
      blocking: blockingValues.map(issueFrom).map(taskFrom),
      linkedPullRequests: Array.from(new Map(linked.map((pull) => [pull.number, pull])).values()),
    };
  }

  private async optionalRelation(path: string, context: string): Promise<unknown | null> {
    try {
      return await this.api.restJson(path, context);
    } catch (error) {
      if (error instanceof GitHubApiError && error.statusCode === 404) return null;
      throw error;
    }
  }

  async createIssue(options: CreateIssueInput): Promise<TaskIssue> {
    const fields: Array<[string, string]> = [["title", options.title], ["body", options.body], ["labels[]", options.label]];
    const typedFields: Array<[string, string]> = [];
    for (const login of options.assignees ?? []) fields.push(["assignees[]", login]);
    if (options.milestone !== undefined && options.milestone !== null) typedFields.push(["milestone", String(options.milestone)]);
    let issue: TaskIssue;
    try {
      issue = issueFrom(await this.api.restJson(this.path("issues"), "Could not create the GitHub issue.", { method: "POST", fields, typedFields, mutation: true }));
    } catch (error) {
      if (error instanceof GitHubApiError && error.code === "ambiguous") throw this.ambiguousCreateError(options.title, error.message);
      throw error;
    }
    if (options.state === "open") return issue;
    try {
      return issueFrom(await this.api.restJson(this.path(`issues/${issue.number}`), `Created issue #${issue.number} but could not close it.`, { method: "PATCH", fields: [["state", "closed"]], mutation: true }));
    } catch (error) {
      throw new PartialCreateError(errorMessage(error), issue);
    }
  }

  private ambiguousCreateError(title: string, detail: string): AmbiguousCreateError {
    const recoveryUrl = `https://github.com/${this.repository}/issues`;
    return new AmbiguousCreateError(`Could not confirm whether GitHub created "${title}". Do not retry yet: run \`gitasks list --state all\` or open ${recoveryUrl} and search for the exact title. Reuse it if found; retry only after confirming it does not exist.\n\n${detail}`, title, recoveryUrl);
  }

  async updateIssue(issueNumber: number, input: { title?: string; body?: string; milestone?: number | null }): Promise<TaskIssue> {
    const current = await this.getIssue(issueNumber);
    const fields: Array<[string, string]> = [];
    const typedFields: Array<[string, string]> = [];
    if (input.title !== undefined) {
      const logicalTitle = stripTaskStatusPrefixes(input.title);
      const status = inferTaskStatus(current.labels, current.title);
      fields.push(["title", status === undefined ? logicalTitle : formatTaskTitle(logicalTitle, status)]);
    }
    if (input.body !== undefined) fields.push(["body", input.body]);
    if (input.milestone !== undefined) typedFields.push(["milestone", input.milestone === null ? "null" : String(input.milestone)]);
    try {
      const updated = issueFrom(await this.api.restJson(this.path(`issues/${issueNumber}`), `Could not update issue #${issueNumber}.`, { method: "PATCH", fields, typedFields, mutation: true }));
      this.verifyIssueUpdate(updated, input);
      return updated;
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.code !== "ambiguous") throw error;
      const verified = await this.getIssue(issueNumber);
      this.verifyIssueUpdate(verified, input);
      return verified;
    }
  }

  private verifyIssueUpdate(issue: TaskIssue, input: { title?: string; body?: string; milestone?: number | null }): void {
    if (input.title !== undefined && stripTaskStatusPrefixes(issue.title) !== stripTaskStatusPrefixes(input.title)) throw new GitHubApiError("GitHub did not apply the requested issue title.", "verification-failed", false, true);
    if (input.body !== undefined && issue.body !== input.body) throw new GitHubApiError("GitHub did not apply the requested issue description.", "verification-failed", false, true);
    if (input.milestone !== undefined && (issue.milestone?.number ?? null) !== input.milestone) throw new GitHubApiError("GitHub did not apply the requested milestone.", "verification-failed", false, true);
  }

  private async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.api.restRaw(this.path(`issues/${issueNumber}/labels/${encodeURIComponent(label)}`), `Could not remove status label ${label} from issue #${issueNumber}.`, { method: "DELETE", mutation: true });
    } catch (error) {
      if (error instanceof GitHubApiError && error.statusCode === 404) return;
      throw error;
    }
  }

  async transitionIssue(issueNumber: number, transition: IssueTransition): Promise<TaskIssue> {
    await this.api.restJson(this.path(`issues/${issueNumber}/labels`), `Could not add status label ${transition.nextStatusLabel} to issue #${issueNumber}.`, { method: "POST", fields: [["labels[]", transition.nextStatusLabel]], mutation: true });
    await this.api.restJson(this.path(`issues/${issueNumber}`), `Could not update issue #${issueNumber}.`, { method: "PATCH", fields: [["title", transition.title], ["state", transition.state]], mutation: true });
    for (const label of transition.previousStatusLabels) if (label.toLowerCase() !== transition.nextStatusLabel.toLowerCase()) await this.removeLabel(issueNumber, label);
    let updated = await this.getIssue(issueNumber);
    const conflicting = updated.labels.filter((label) => isStatusLabel(label) && label.toLowerCase() !== transition.nextStatusLabel.toLowerCase());
    for (const label of conflicting) await this.removeLabel(issueNumber, label);
    if (conflicting.length > 0) updated = await this.getIssue(issueNumber);
    return updated;
  }

  async listAssignees(): Promise<UserSummary[]> {
    const values = await this.api.allPages(this.path("assignees"), "Could not list repository assignees.");
    return values.map(userFrom).filter((user): user is UserSummary => user !== null);
  }

  async mutateIssueAssignee(issueNumber: number, login: string, add: boolean): Promise<TaskIssue> {
    try {
      await this.api.restJson(this.path(`issues/${issueNumber}/assignees`), `Could not ${add ? "assign" : "unassign"} @${login} ${add ? "to" : "from"} issue #${issueNumber}.`, { method: add ? "POST" : "DELETE", fields: [["assignees[]", login]], mutation: true });
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.code !== "ambiguous") throw error;
    }
    const issue = await this.getIssue(issueNumber);
    const normalizedLogin = login.toLowerCase();
    if (issue.assignees.some((assignee) => assignee.toLowerCase() === normalizedLogin) !== add) throw new GitHubApiError(`GitHub did not ${add ? "assign" : "unassign"} @${login}.`, "verification-failed", false, true);
    return issue;
  }

  async listMilestones(state: "open" | "closed" | "all"): Promise<ListPage<MilestoneSummary>> {
    const values = await this.api.allPages(this.path(`milestones?state=${state}`), "Could not list milestones.");
    return { items: values.map(milestoneFrom).filter((item): item is MilestoneSummary => item !== null), hasNext: false, complete: true, nextPage: null, knownTotal: null };
  }

  async createMilestone(input: { title: string; description?: string; dueOn?: string | null }): Promise<MilestoneSummary> {
    const fields: Array<[string, string]> = [["title", input.title]];
    const typedFields: Array<[string, string]> = [];
    if (input.description !== undefined) fields.push(["description", input.description]);
    if (input.dueOn !== undefined) {
      if (input.dueOn === null) typedFields.push(["due_on", "null"]);
      else fields.push(["due_on", `${input.dueOn}T23:59:59Z`]);
    }
    try {
      const milestone = milestoneFrom(await this.api.restJson(this.path("milestones"), "Could not create milestone.", { method: "POST", fields, typedFields, mutation: true }));
      if (milestone === null) throw new GitHubApiError("GitHub returned an invalid milestone.", "ambiguous", false);
      return milestone;
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.code !== "ambiguous") throw error;
      const recoveryUrl = `https://github.com/${this.repository}/milestones`;
      throw new AmbiguousMilestoneCreateError(`Could not confirm whether GitHub created milestone "${input.title}". Do not retry until you open ${recoveryUrl} and search for the exact title.\n\n${error.message}`, input.title, recoveryUrl);
    }
  }

  async updateMilestone(number: number, input: { title?: string; description?: string; dueOn?: string | null; state?: "open" | "closed" }): Promise<MilestoneSummary> {
    const fields: Array<[string, string]> = [];
    const typedFields: Array<[string, string]> = [];
    if (input.title !== undefined) fields.push(["title", input.title]);
    if (input.description !== undefined) fields.push(["description", input.description]);
    if (input.dueOn !== undefined) {
      if (input.dueOn === null) typedFields.push(["due_on", "null"]);
      else fields.push(["due_on", `${input.dueOn}T23:59:59Z`]);
    }
    if (input.state !== undefined) fields.push(["state", input.state]);
    let milestone: MilestoneSummary;
    try {
      const value = milestoneFrom(await this.api.restJson(this.path(`milestones/${number}`), `Could not update milestone #${number}.`, { method: "PATCH", fields, typedFields, mutation: true }));
      if (value === null) throw new GitHubApiError("GitHub returned an invalid milestone.", "ambiguous", false);
      milestone = value;
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.code !== "ambiguous") throw error;
      const value = milestoneFrom(await this.api.restJson(this.path(`milestones/${number}`), `Could not verify milestone #${number}.`));
      if (value === null) throw error;
      milestone = value;
    }
    if (input.title !== undefined && milestone.title !== input.title) throw new GitHubApiError("GitHub did not apply the milestone title.", "verification-failed", false, true);
    if (input.description !== undefined && milestone.description !== input.description) throw new GitHubApiError("GitHub did not apply the milestone description.", "verification-failed", false, true);
    if (input.dueOn !== undefined && (milestone.dueOn?.slice(0, 10) ?? null) !== input.dueOn) throw new GitHubApiError("GitHub did not apply the milestone due date.", "verification-failed", false, true);
    if (input.state !== undefined && milestone.state !== input.state) throw new GitHubApiError("GitHub did not apply the milestone state.", "verification-failed", false, true);
    return milestone;
  }

  async getMilestoneItems(number: number): Promise<MilestoneItems> {
    const values = await this.api.allPages(this.path(`issues?state=all&milestone=${number}`), `Could not load items for milestone #${number}.`);
    const issues: TaskSummary[] = [];
    const pullRequests: PullRequestSummary[] = [];
    for (const value of values) {
      const object = expectObject(value, "Could not read milestone item.");
      if (object.pull_request === undefined) issues.push(taskFrom(issueFrom(object)));
      else pullRequests.push(await this.getPullRequest(requiredNumber(object.number, "pull request number", "Could not read milestone item.")));
    }
    return { issues, pullRequests, complete: true };
  }

  async listBranches(): Promise<string[]> {
    const values = await this.api.allPages(this.path("branches"), "Could not list repository branches.");
    return values.map((value) => requiredString(expectObject(value, "Could not read branch.").name, "branch name", "Could not read branch."));
  }
  async listPullRequests(state: "open" | "closed" | "merged" | "all", page: number): Promise<ListPage<PullRequestSummary>> {
    const apiState = state === "open" ? "open" : state === "all" ? "all" : "closed";
    const value = await this.api.restJson(this.path(`pulls?state=${apiState}&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=${page}`), "Could not list pull requests.");
    const rawItems = expectArray(value, "Could not list pull requests.").map(pullFrom);
    let items = rawItems;
    if (state === "merged") items = items.filter((pull) => pull.mergedAt !== null);
    else if (state === "closed") items = items.filter((pull) => pull.mergedAt === null);
    return pageOf(items, page, rawItems.length);
  }

  async createPullRequest(input: { title: string; body: string; head: string; base: string; draft: boolean }): Promise<PullRequestSummary> {
    try {
      return pullFrom(await this.api.restJson(this.path("pulls"), "Could not create the pull request.", {
        method: "POST",
        fields: [["title", input.title], ["body", input.body], ["head", input.head], ["base", input.base]],
        typedFields: [["draft", String(input.draft)]],
        mutation: true,
      }));
    } catch (error) {
      if (error instanceof GitHubApiError && error.code === "ambiguous") throw new GitHubApiError(`Could not confirm whether GitHub created the pull request. Do not retry until you inspect ${`https://github.com/${this.repository}/pulls`}.\n\n${error.message}`, "ambiguous-create", false, false);
      throw error;
    }
  }

  async getPullRequest(number: number): Promise<PullRequestSummary> {
    return pullFrom(await this.api.restJson(this.path(`pulls/${number}`), `Could not load pull request #${number}.`));
  }

  private async loadCheckRuns(number: number, sha: string): Promise<Record<string, unknown>> {
    const checkRuns: unknown[] = [];
    let totalCount = 0;
    for (let page = 1; page <= 10; page += 1) {
      const value = expectObject(
        await this.api.restJson(
          this.path(`commits/${encodeURIComponent(sha)}/check-runs?per_page=${PAGE_SIZE}&page=${page}&filter=latest`),
          `Could not load checks for pull request #${number}.`,
        ),
        `Could not load checks for pull request #${number}.`,
      );
      const pageItems = expectArray(value.check_runs, `Could not load checks for pull request #${number}.`);
      if (typeof value.total_count === "number" && Number.isSafeInteger(value.total_count)) totalCount = value.total_count;
      checkRuns.push(...pageItems);
      if (pageItems.length < PAGE_SIZE || checkRuns.length >= totalCount) break;
    }
    return { total_count: totalCount, check_runs: checkRuns };
  }

  private async loadPullFiles(number: number, knownTotal: number | null): Promise<{ values: unknown[]; coverage: PullRequestDetail["fileCoverage"] }> {
    const values: unknown[] = [];
    let complete = false;
    for (let page = 1; page <= PULL_REQUEST_FILE_LIMIT / PAGE_SIZE; page += 1) {
      const pageValue = expectArray(
        await this.api.restJson(this.path(`pulls/${number}/files?per_page=${PAGE_SIZE}&page=${page}`), `Could not load files for pull request #${number}.`),
        `Could not load files for pull request #${number}.`,
      );
      values.push(...pageValue);
      if (pageValue.length < PAGE_SIZE || (knownTotal !== null && values.length >= knownTotal)) {
        complete = knownTotal === null ? pageValue.length < PAGE_SIZE : values.length >= knownTotal;
        break;
      }
    }
    if (knownTotal !== null) complete = values.length >= knownTotal;
    return {
      values,
      coverage: { complete, loaded: values.length, knownTotal, limit: PULL_REQUEST_FILE_LIMIT },
    };
  }

  private async loadClosingIssues(number: number): Promise<TaskSummary[]> {
    const [owner = "", name = ""] = this.repository.split("/", 2);
    const issueNumbers: number[] = [];
    let cursor: string | undefined;
    do {
      const variables: Array<[string, string]> = [["owner", owner], ["name", name], ["number", String(number)]];
      if (cursor !== undefined) variables.push(["cursor", cursor]);
      const value = expectObject(
        await this.api.graphql(
          "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:100,after:$cursor){nodes{number repository{nameWithOwner}}pageInfo{hasNextPage endCursor}}}}}",
          variables,
          `Could not load closing issues for pull request #${number}.`,
        ),
        `Could not load closing issues for pull request #${number}.`,
      );
      const data = expectObject(value.data, `Could not load closing issues for pull request #${number}.`);
      const repository = expectObject(data.repository, `Could not load closing issues for pull request #${number}.`);
      const pullRequest = expectObject(repository.pullRequest, `Could not load closing issues for pull request #${number}.`);
      const connection = expectObject(pullRequest.closingIssuesReferences, `Could not load closing issues for pull request #${number}.`);
      for (const nodeValue of expectArray(connection.nodes, `Could not load closing issues for pull request #${number}.`)) {
        const node = expectObject(nodeValue, `Could not load closing issue for pull request #${number}.`);
        const nodeRepository = expectObject(node.repository, `Could not load closing issue for pull request #${number}.`);
        if (optionalString(nodeRepository.nameWithOwner).toLowerCase() === this.repository.toLowerCase()) {
          issueNumbers.push(requiredNumber(node.number, "issue number", `Could not load closing issue for pull request #${number}.`));
        }
      }
      const pageInfo = expectObject(connection.pageInfo, `Could not load closing issues for pull request #${number}.`);
      if (pageInfo.hasNextPage !== true) cursor = undefined;
      else cursor = requiredString(pageInfo.endCursor, "closing issues cursor", `Could not load closing issues for pull request #${number}.`);
    } while (cursor !== undefined);
    const uniqueNumbers = Array.from(new Set(issueNumbers));
    return Promise.all(uniqueNumbers.map(async (issueNumber) => taskFrom(await this.getIssue(issueNumber))));
  }

  async getPullRequestDetail(number: number): Promise<PullRequestDetail> {
    const pullValue = await this.api.restJson(this.path(`pulls/${number}`), `Could not load pull request #${number}.`);
    const pullObject = expectObject(pullValue, `Could not load pull request #${number}.`);
    const pullRequest = pullFrom(pullObject);
    const knownFileTotal = typeof pullObject.changed_files === "number" && Number.isSafeInteger(pullObject.changed_files) && pullObject.changed_files >= 0
      ? pullObject.changed_files
      : null;
    const [reviewersValue, reviewsValues, filesResult, statusValue, checksValue, repositoryValue, timelineValues, closingIssues] = await Promise.all([
      this.api.restJson(this.path(`pulls/${number}/requested_reviewers`), `Could not load reviewers for pull request #${number}.`),
      this.api.allPages(this.path(`pulls/${number}/reviews`), `Could not load reviews for pull request #${number}.`),
      this.loadPullFiles(number, knownFileTotal),
      this.api.restJson(this.path(`commits/${encodeURIComponent(pullRequest.head.sha)}/status`), `Could not load statuses for pull request #${number}.`),
      this.loadCheckRuns(number, pullRequest.head.sha),
      this.api.restJson(this.path(""), "Could not read repository merge settings."),
      this.api.allPages(this.path(`issues/${number}/timeline`), `Could not load linked issues for pull request #${number}.`),
      this.loadClosingIssues(number),
    ]);
    const reviewersObject = expectObject(reviewersValue, "Could not read requested reviewers.");
    const requestedReviewers = (Array.isArray(reviewersObject.users) ? reviewersObject.users : []).map(userFrom).filter((user): user is UserSummary => user !== null);
    const reviews = reviewsValues.map((value): PullRequestReview => {
      const review = expectObject(value, "Could not read pull request review.");
      return { id: requiredNumber(review.id, "review id", "Could not read pull request review."), nodeId: optionalString(review.node_id), user: userFrom(review.user), body: optionalString(review.body), state: optionalString(review.state), submittedAt: nullableString(review.submitted_at), url: optionalString(review.html_url) };
    });
    const files = filesResult.values.map((value): PullRequestFile => {
      const file = expectObject(value, "Could not read pull request file.");
      return { filename: requiredString(file.filename, "filename", "Could not read pull request file."), status: optionalString(file.status), additions: Number(file.additions) || 0, deletions: Number(file.deletions) || 0, changes: Number(file.changes) || 0, patch: nullableString(file.patch), blobUrl: optionalString(file.blob_url) };
    });
    const combinedStatus = this.combinedStatus(statusValue, checksValue);
    const latestDecisions = new Map<string, { state: "APPROVED" | "CHANGES_REQUESTED"; submittedAt: string; id: number }>();
    for (const review of reviews) {
      const state = review.state.toUpperCase();
      if (state !== "APPROVED" && state !== "CHANGES_REQUESTED") continue;
      const key = review.user?.login.toLowerCase() ?? `review:${review.id}`;
      const submittedAt = review.submittedAt ?? "";
      const previous = latestDecisions.get(key);
      if (previous === undefined || submittedAt > previous.submittedAt || (submittedAt === previous.submittedAt && review.id > previous.id)) {
        latestDecisions.set(key, { state, submittedAt, id: review.id });
      }
    }
    const effectiveDecisions = Array.from(latestDecisions.values(), ({ state }) => state);
    if (pullRequest.draft) pullRequest.reviewState = "pending";
    else if (effectiveDecisions.includes("CHANGES_REQUESTED")) pullRequest.reviewState = "changes-requested";
    else if (effectiveDecisions.includes("APPROVED")) pullRequest.reviewState = "approved";
    else if (requestedReviewers.length > 0) pullRequest.reviewState = "review-required";
    const failingChecks: Record<string, true> = { failure: true, cancelled: true, timed_out: true, action_required: true, startup_failure: true };
    const hasFailedCheck = combinedStatus.checkRuns.some(({ conclusion }) => conclusion !== null && failingChecks[conclusion] === true);
    const hasPendingCheck = combinedStatus.checkRuns.some(({ status }) => status !== "completed");
    const legacyState = combinedStatus.state.toLowerCase();
    const allChecksNeutral = combinedStatus.checkRuns.length > 0
      && combinedStatus.checkRuns.every(({ conclusion }) => conclusion === "neutral" || conclusion === "skipped");
    if (hasFailedCheck || legacyState === "failure" || legacyState === "error") pullRequest.checksState = "failure";
    else if (hasPendingCheck || (combinedStatus.statuses.length > 0 && legacyState === "pending")) pullRequest.checksState = "pending";
    else if (allChecksNeutral && combinedStatus.statuses.length === 0) pullRequest.checksState = "neutral";
    else if (combinedStatus.checkRuns.length > 0 || legacyState === "success") pullRequest.checksState = "success";
    const repository = expectObject(repositoryValue, "Could not read repository merge settings.");
    const allowedMergeMethods: MergeMethod[] = [];
    if (repository.allow_merge_commit === true) allowedMergeMethods.push("merge");
    if (repository.allow_squash_merge === true) allowedMergeMethods.push("squash");
    if (repository.allow_rebase_merge === true) allowedMergeMethods.push("rebase");
    const timelineIssues = timelineValues.flatMap((event) => {
      const object = expectObject(event, "Could not read pull request timeline.");
      if (object.event !== "cross-referenced") return [];
      if (object.source === null || typeof object.source !== "object") return [];
      const source = expectObject(object.source, "Could not read pull request timeline source.").issue;
      if (source === undefined) return [];
      const sourceObject = expectObject(source, "Could not read linked issue.");
      return sourceObject.pull_request === undefined ? [taskFrom(issueFrom(sourceObject))] : [];
    });
    const linkedIssues = Array.from(new Map([...timelineIssues, ...closingIssues].map((issue) => [issue.number, issue])).values());
    return { pullRequest, requestedReviewers, reviews, files, fileCoverage: filesResult.coverage, combinedStatus, mergeable: typeof pullObject.mergeable === "boolean" ? pullObject.mergeable : null, mergeableState: optionalString(pullObject.mergeable_state), allowedMergeMethods, linkedIssues };
  }

  private combinedStatus(statusValue: unknown, checksValue: unknown): CombinedStatus {
    const status = expectObject(statusValue, "Could not read combined commit status.");
    const checks = expectObject(checksValue, "Could not read check runs.");
    const statuses = (Array.isArray(status.statuses) ? status.statuses : []).map((value) => {
      const item = expectObject(value, "Could not read commit status.");
      return { id: Number.isSafeInteger(item.id) ? item.id as number : 0, context: optionalString(item.context), state: optionalString(item.state), description: nullableString(item.description), targetUrl: nullableString(item.target_url) };
    });
    const checkRuns = (Array.isArray(checks.check_runs) ? checks.check_runs : []).map((value) => {
      const item = expectObject(value, "Could not read check run.");
      return { id: requiredNumber(item.id, "check run id", "Could not read check run."), name: optionalString(item.name), status: optionalString(item.status), conclusion: nullableString(item.conclusion), detailsUrl: nullableString(item.details_url), startedAt: nullableString(item.started_at), completedAt: nullableString(item.completed_at) };
    });
    const totalLegacyStatuses = typeof status.total_count === "number" && Number.isSafeInteger(status.total_count) ? status.total_count : statuses.length;
    const totalCheckRuns = typeof checks.total_count === "number" && Number.isSafeInteger(checks.total_count) ? checks.total_count : checkRuns.length;
    return { state: optionalString(status.state) || "pending", totalCount: totalLegacyStatuses + totalCheckRuns, statuses, checkRuns, complete: totalCheckRuns <= checkRuns.length };
  }

  async updatePullRequest(number: number, input: { title?: string; body?: string; state?: "open" | "closed"; milestone?: number | null }): Promise<PullRequestSummary> {
    const fields: Array<[string, string]> = [];
    const typedFields: Array<[string, string]> = [];
    if (input.title !== undefined) fields.push(["title", input.title]);
    if (input.body !== undefined) fields.push(["body", input.body]);
    if (input.state !== undefined) fields.push(["state", input.state]);
    if (input.milestone !== undefined) typedFields.push(["milestone", input.milestone === null ? "null" : String(input.milestone)]);
    if (fields.length > 0 || typedFields.length > 0) {
      try {
        await this.api.restJson(this.path(`issues/${number}`), `Could not update pull request #${number}.`, { method: "PATCH", fields, typedFields, mutation: true });
      } catch (error) {
        if (!(error instanceof GitHubApiError) || error.code !== "ambiguous") throw error;
      }
    }
    const pull = await this.getPullRequest(number);
    if (input.title !== undefined && pull.title !== input.title) throw new GitHubApiError("GitHub did not apply the pull request title.", "verification-failed", false, true);
    if (input.body !== undefined && pull.body !== input.body) throw new GitHubApiError("GitHub did not apply the pull request description.", "verification-failed", false, true);
    if (input.state !== undefined && pull.state !== input.state) throw new GitHubApiError("GitHub did not apply the pull request state.", "verification-failed", false, true);
    if (input.milestone !== undefined && (pull.milestone?.number ?? null) !== input.milestone) throw new GitHubApiError("GitHub did not apply the pull request milestone.", "verification-failed", false, true);
    return pull;
  }

  async mutatePullAssignee(number: number, login: string, add: boolean): Promise<PullRequestSummary> {
    try { await this.api.restJson(this.path(`issues/${number}/assignees`), `Could not update assignees for pull request #${number}.`, { method: add ? "POST" : "DELETE", fields: [["assignees[]", login]], mutation: true }); }
    catch (error) { if (!(error instanceof GitHubApiError) || error.code !== "ambiguous") throw error; }
    const pull = await this.getPullRequest(number);
    if (pull.assignees.some((user) => user.login.toLowerCase() === login.toLowerCase()) !== add) throw new GitHubApiError("GitHub did not apply the requested assignee change.", "verification-failed", false, true);
    return pull;
  }

  async setPullDraft(number: number, draft: boolean): Promise<PullRequestSummary> {
    const pull = await this.getPullRequest(number);
    if (pull.draft === draft) return pull;
    const mutation = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
    const query = `mutation($id:ID!){${mutation}(input:{pullRequestId:$id}){pullRequest{number}}}`;
    try { await this.api.graphql(query, [["id", pull.nodeId]], `Could not mark pull request #${number} as ${draft ? "draft" : "ready"}.`, true); }
    catch (error) { if (!(error instanceof GitHubApiError) || error.code !== "ambiguous") throw error; }
    const verified = await this.getPullRequest(number);
    if (verified.draft !== draft) throw new GitHubApiError("GitHub did not apply the requested draft state.", "verification-failed", false, true);
    return verified;
  }

  async mutateReviewer(number: number, login: string, add: boolean): Promise<PullRequestDetail> {
    try { await this.api.restJson(this.path(`pulls/${number}/requested_reviewers`), `Could not update requested reviewers for pull request #${number}.`, { method: add ? "POST" : "DELETE", fields: [["reviewers[]", login]], mutation: true }); }
    catch (error) { if (!(error instanceof GitHubApiError) || error.code !== "ambiguous") throw error; }
    const detail = await this.getPullRequestDetail(number);
    if (detail.requestedReviewers.some((user) => user.login.toLowerCase() === login.toLowerCase()) !== add) throw new GitHubApiError("GitHub did not apply the requested reviewer change.", "verification-failed", false, true);
    return detail;
  }

  async createReview(number: number, event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string): Promise<PullRequestDetail> {
    const before = await this.getPullRequestDetail(number);
    const beforeIds = new Set(before.reviews.map(({ id }) => id));
    const recoveryUrl = before.pullRequest.url || `https://github.com/${this.repository}/pull/${number}`;
    let needsVerification = false;
    try {
      await this.api.restJson(this.path(`pulls/${number}/reviews`), `Could not submit a review for pull request #${number}.`, { method: "POST", fields: [["event", event], ["body", body]], mutation: true });
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.code !== "ambiguous") throw error;
      needsVerification = true;
    }
    let after: PullRequestDetail;
    try {
      after = await this.getPullRequestDetail(number);
    } catch (error) {
      throw new GitHubApiError(`Could not confirm whether GitHub submitted the review. Do not retry until you inspect ${recoveryUrl}.\n\n${errorMessage(error)}`, "ambiguous-review", false, false);
    }
    if (needsVerification) {
      const expectedState: Record<typeof event, string> = {
        COMMENT: "COMMENTED",
        APPROVE: "APPROVED",
        REQUEST_CHANGES: "CHANGES_REQUESTED",
      };
      const verified = after.reviews.some((review) =>
        !beforeIds.has(review.id)
        && review.body === body
        && review.state.toUpperCase() === expectedState[event]);
      if (!verified) throw new GitHubApiError(`Could not confirm whether GitHub submitted the review. Do not retry until you inspect ${recoveryUrl}.`, "ambiguous-review", false, false);
    }
    return after;
  }

  async mergePullRequest(number: number, method: MergeMethod, expectedHeadSha: string): Promise<PullRequestSummary> {
    const current = await this.getPullRequest(number);
    if (current.head.sha !== expectedHeadSha) throw new GitHubApiError(`Pull request #${number} changed from ${expectedHeadSha} to ${current.head.sha}. Review the new commit before merging.`, "stale-head", false, true, 409);
    const recoveryUrl = current.url || `https://github.com/${this.repository}/pull/${number}`;
    let needsVerification = false;
    try {
      const resultValue = await this.api.restJson(this.path(`pulls/${number}/merge`), `Could not merge pull request #${number}.`, { method: "PUT", fields: [["merge_method", method], ["sha", expectedHeadSha]], mutation: true });
      let result: Record<string, unknown>;
      try {
        result = expectObject(resultValue, `Could not merge pull request #${number}.`);
      } catch (error) {
        throw new GitHubApiError(`Could not confirm whether pull request #${number} was merged. Do not retry until you inspect ${recoveryUrl}.\n\n${errorMessage(error)}`, "ambiguous-merge", false, false);
      }
      if (result.merged !== true) throw new GitHubApiError(optionalString(result.message) || `GitHub did not merge pull request #${number}.`, "merge-rejected", false, true);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.code !== "ambiguous") throw error;
      needsVerification = true;
    }
    if (needsVerification) {
      try {
        await this.api.restRaw(this.path(`pulls/${number}/merge`), `Could not verify whether pull request #${number} was merged.`);
      } catch (error) {
        throw new GitHubApiError(`Could not confirm whether pull request #${number} was merged. Do not retry until you inspect ${recoveryUrl}.\n\n${errorMessage(error)}`, "ambiguous-merge", false, false);
      }
    }
    try {
      return await this.getPullRequest(number);
    } catch (error) {
      throw new GitHubApiError(`GitHub accepted the merge, but the updated pull request could not be loaded. Do not retry until you inspect ${recoveryUrl}.\n\n${errorMessage(error)}`, "ambiguous-merge", false, false);
    }
  }

  async mutateSubIssue(parentNumber: number, issueNumber: number, add: boolean): Promise<TaskDetail> {
    const child = await this.getIssue(issueNumber);
    if ((child.id ?? 0) <= 0) throw new GitHubApiError(`GitHub did not provide the database ID for issue #${issueNumber}.`, "invalid-response", false);
    const path = this.path(`issues/${parentNumber}/${add ? "sub_issues" : "sub_issue"}`);
    try { await this.api.restRaw(path, `Could not ${add ? "add" : "remove"} sub-issue #${issueNumber}.`, { method: add ? "POST" : "DELETE", typedFields: [["sub_issue_id", String(child.id)]], mutation: true, unsupportedOnNotFound: true }); }
    catch (error) { if (!(error instanceof GitHubApiError) || error.code !== "ambiguous") throw error; }
    const detail = await this.getIssueDetail(parentNumber);
    if (detail.subIssues.some((issue) => issue.id === child.id) !== add) throw new GitHubApiError("GitHub did not apply the requested sub-issue change.", "verification-failed", false, true);
    return detail;
  }

  async mutateBlockedBy(number: number, blockerNumber: number, add: boolean): Promise<TaskDetail> {
    const blocker = await this.getIssue(blockerNumber);
    if ((blocker.id ?? 0) <= 0) throw new GitHubApiError(`GitHub did not provide the database ID for issue #${blockerNumber}.`, "invalid-response", false);
    const suffix = add ? `issues/${number}/dependencies/blocked_by` : `issues/${number}/dependencies/blocked_by/${blocker.id}`;
    try { await this.api.restRaw(this.path(suffix), `Could not ${add ? "add" : "remove"} blocker #${blockerNumber}.`, { method: add ? "POST" : "DELETE", typedFields: add ? [["issue_id", String(blocker.id)]] : [], mutation: true, unsupportedOnNotFound: true }); }
    catch (error) { if (!(error instanceof GitHubApiError) || error.code !== "ambiguous") throw error; }
    const detail = await this.getIssueDetail(number);
    if (detail.blockedBy.some((issue) => issue.id === blocker.id) !== add) throw new GitHubApiError("GitHub did not apply the requested dependency change.", "verification-failed", false, true);
    return detail;
  }

  async listActivity(page: number): Promise<ListPage<ActivityEvent>> {
    const value = await this.api.restJson(this.path(`issues/events?per_page=${PAGE_SIZE}&page=${page}`), "Could not load repository activity.");
    const rawItems = expectArray(value, "Could not load repository activity.");
    const events = rawItems.flatMap((raw, index): ActivityEvent[] => {
      const event = expectObject(raw, "Could not read repository activity.");
      if (event.issue === null || typeof event.issue !== "object" || typeof event.created_at !== "string") return [];
      const issue = expectObject(event.issue, "Could not read activity subject.");
      const number = typeof issue.number === "number" && Number.isSafeInteger(issue.number) ? issue.number : 0;
      if (number <= 0) return [];
      const kind = issue.pull_request === undefined ? "issue" as const : "pull-request" as const;
      return [{ id: String(event.id ?? `${page}-${index}`), type: optionalString(event.event) || "unknown", actor: userFrom(event.actor), subject: { kind, number, title: optionalString(issue.title), url: optionalString(issue.html_url) }, action: optionalString(event.event).replaceAll("_", " ") || "updated", createdAt: event.created_at }];
    });
    return pageOf(events, page, rawItems.length);
  }

  async getOverview(): Promise<OverviewPayload> {
    const section = async <T>(load: () => Promise<T>): Promise<OverviewSection<T>> => {
      try { return { available: true, data: await load(), error: null }; }
      catch (error) { return { available: false, data: null, error: { error: errorMessage(error), code: error instanceof GitHubApiError ? error.code : "github", retryable: error instanceof GitHubApiError ? error.retryable : true, stateVerified: error instanceof GitHubApiError ? error.stateVerified : false } }; }
    };
    const issuesPromise = this.listIssues("open");
    const pullsPromise = this.listPullRequests("open", 1);
    const milestonesPromise = this.listMilestones("open");
    const viewerPromise = this.getContext();
    const [openIssues, inProgressIssues, blockedIssues, openPullRequests, assignedToMe, upcomingMilestones, recentlyUpdated] = await Promise.all([
      section(async () => (await issuesPromise).length),
      section(async () => (await issuesPromise).filter((issue) => inferTaskStatus(issue.labels, issue.title) === "IN PROGRESS").length),
      section(async () => (await issuesPromise).filter((issue) => inferTaskStatus(issue.labels, issue.title) === "BLOCKED").length),
      section(async () => {
        const pulls = await pullsPromise;
        if (pulls.hasNext) throw new GitHubApiError("Open pull request count is unavailable because GitHub returned more than one page.", "partial", true, true);
        return pulls.items.length;
      }),
      section(async () => { const [issues, context] = await Promise.all([issuesPromise, viewerPromise]); return issues.filter((issue) => issue.assignees.includes(context.currentUser.login)).map(taskFrom); }),
      section(async () => (await milestonesPromise).items.slice().sort((a, b) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999")).slice(0, 5)),
      section(async () => { const [issues, pulls] = await Promise.all([issuesPromise, pullsPromise]); return [...issues.map(taskFrom), ...pulls.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10); }),
    ]);
    return { openIssues, inProgressIssues, blockedIssues, openPullRequests, assignedToMe, upcomingMilestones, recentlyUpdated };
  }
}
