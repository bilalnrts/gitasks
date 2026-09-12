import { STATUS_DEFINITIONS, isStatusLabel } from "../tasks/statuses.js";
import type {
  CreateIssueInput,
  IssueTransition,
  TaskGateway,
  TaskIssue,
} from "../tasks/types.js";
import type { CommandRunner } from "../utils/exec.js";
import { errorMessage, PartialCreateError, UserError } from "../utils/errors.js";

interface GitHubIssueJson {
  number: number;
  title: string;
  state: string;
  body?: string | null;
  assignees?: Array<{ login: string }>;
  labels: Array<{ name: string }>;
  url?: string;
  html_url?: string;
  pull_request?: unknown;
}

function toTaskIssue(issue: GitHubIssueJson): TaskIssue {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state.toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN",
    labels: issue.labels.map(({ name }) => name),
    url: issue.html_url ?? issue.url ?? "",
    body: issue.body ?? "",
    assignees: issue.assignees?.map(({ login }) => login) ?? [],
  };
}

export class GitHubClient implements TaskGateway {
  constructor(
    readonly repository: string,
    private readonly runner: CommandRunner,
  ) {}

  private async run(args: readonly string[], context: string): Promise<string> {
    try {
      return (await this.runner("gh", args)).stdout;
    } catch (error) {
      throw new UserError(`${context}\n\n${errorMessage(error)}`);
    }
  }

  private async runJson<T>(args: readonly string[], context: string): Promise<T> {
    const stdout = await this.run(args, context);
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new UserError(
        `${context}\n\nGitHub CLI returned an unexpected response.`,
      );
    }
  }

  private async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.runner("gh", [
        "api",
        "--method",
        "DELETE",
        `repos/${this.repository}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      ]);
    } catch (error) {
      const detail = errorMessage(error);
      if (/\b404\b|label does not exist/i.test(detail)) {
        return;
      }
      throw new UserError(
        `Could not remove status label ${label} from issue #${issueNumber}.\n\n${detail}`,
      );
    }
  }

  async ensureStatusLabels(): Promise<string[]> {
    const labels = await this.runJson<Array<{ name: string }>>(
      ["label", "list", "--repo", this.repository, "--limit", "1000", "--json", "name"],
      "Could not read repository labels.",
    );
    const existing = new Set(labels.map(({ name }) => name.toLowerCase()));
    const created: string[] = [];

    for (const definition of STATUS_DEFINITIONS) {
      if (existing.has(definition.label)) {
        continue;
      }

      await this.run(
        [
          "label",
          "create",
          definition.label,
          "--repo",
          this.repository,
          "--color",
          definition.color,
          "--description",
          `Gitasks status: ${definition.name}`,
        ],
        `Could not create label ${definition.label}.`,
      );
      created.push(definition.label);
    }

    return created;
  }

  async listIssues(state: "open" | "all"): Promise<TaskIssue[]> {
    const pages = await this.runJson<GitHubIssueJson[][]>(
      [
        "api",
        `repos/${this.repository}/issues?state=${state}&per_page=100`,
        "--paginate",
        "--slurp",
      ],
      "Could not list GitHub issues.",
    );
    return pages
      .flat()
      .filter(
        (issue) =>
          issue.pull_request === undefined &&
          (state === "all" || issue.state.toLowerCase() === "open"),
      )
      .map(toTaskIssue);
  }

  async getIssue(issueNumber: number): Promise<TaskIssue> {
    const issue = await this.runJson<GitHubIssueJson>(
      ["api", `repos/${this.repository}/issues/${issueNumber}`],
      `Could not load issue #${issueNumber}. Make sure it exists and is accessible.`,
    );
    if (issue.pull_request !== undefined) {
      throw new UserError(`#${issueNumber} is a pull request, not an issue.`);
    }
    return toTaskIssue(issue);
  }

  async createIssue(options: CreateIssueInput): Promise<TaskIssue> {
    const issue = await this.runJson<GitHubIssueJson>(
      [
        "api",
        "--method",
        "POST",
        `repos/${this.repository}/issues`,
        "--raw-field",
        `title=${options.title}`,
        "--raw-field",
        `body=${options.body}`,
        "--raw-field",
        `labels[]=${options.label}`,
      ],
      "Could not create the GitHub issue.",
    );
    if (options.state === "open") {
      return toTaskIssue(issue);
    }

    try {
      const closedIssue = await this.runJson<GitHubIssueJson>(
        [
          "api",
          "--method",
          "PATCH",
          `repos/${this.repository}/issues/${issue.number}`,
          "--raw-field",
          "state=closed",
        ],
        `Created issue #${issue.number} but could not close it.`,
      );
      return toTaskIssue(closedIssue);
    } catch (error) {
      throw new PartialCreateError(errorMessage(error), toTaskIssue(issue));
    }
  }

  async transitionIssue(
    issueNumber: number,
    transition: IssueTransition,
  ): Promise<TaskIssue> {
    await this.runJson<Array<{ name: string }>>(
      [
        "api",
        "--method",
        "POST",
        `repos/${this.repository}/issues/${issueNumber}/labels`,
        "--raw-field",
        `labels[]=${transition.nextStatusLabel}`,
      ],
      `Could not add status label ${transition.nextStatusLabel} to issue #${issueNumber}.`,
    );

    await this.runJson<GitHubIssueJson>(
      [
        "api",
        "--method",
        "PATCH",
        `repos/${this.repository}/issues/${issueNumber}`,
        "--raw-field",
        `title=${transition.title}`,
        "--raw-field",
        `state=${transition.state}`,
      ],
      `Could not update issue #${issueNumber}.`,
    );

    for (const label of transition.previousStatusLabels) {
      if (label.toLowerCase() !== transition.nextStatusLabel.toLowerCase()) {
        await this.removeLabel(issueNumber, label);
      }
    }

    let updated = await this.getIssue(issueNumber);
    const conflictingLabels = updated.labels.filter(
      (label) =>
        isStatusLabel(label) &&
        label.toLowerCase() !== transition.nextStatusLabel.toLowerCase(),
    );
    for (const label of conflictingLabels) {
      await this.removeLabel(issueNumber, label);
    }
    if (conflictingLabels.length > 0) {
      updated = await this.getIssue(issueNumber);
    }

    return updated;
  }
}
