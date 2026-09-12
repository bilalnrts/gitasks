import { STATUS_DEFINITIONS } from "../tasks/statuses.js";
import type { IssueUpdate, TaskGateway, TaskIssue } from "../tasks/types.js";
import type { CommandRunner } from "../utils/exec.js";
import { errorMessage, UserError } from "../utils/errors.js";

interface GitHubIssueJson {
  number: number;
  title: string;
  state: string;
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
    url: issue.url ?? issue.html_url ?? "",
  };
}

export class GitHubClient implements TaskGateway {
  constructor(
    readonly repository: string,
    private readonly runner: CommandRunner,
  ) {}

  private async runJson<T>(args: readonly string[], context: string): Promise<T> {
    let stdout: string;
    try {
      stdout = (await this.runner("gh", args)).stdout;
    } catch (error) {
      throw new UserError(`${context}\n\n${errorMessage(error)}`);
    }

    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new UserError(
        `${context}\n\nGitHub CLI returned an unexpected response.`,
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

      try {
        await this.runner("gh", [
          "label",
          "create",
          definition.label,
          "--repo",
          this.repository,
          "--color",
          definition.color,
          "--description",
          `Gitasks status: ${definition.name}`,
        ]);
      } catch (error) {
        throw new UserError(
          `Could not create label ${definition.label}.\n\n${errorMessage(error)}`,
        );
      }
      created.push(definition.label);
    }

    return created;
  }

  async listIssues(state: "open" | "all"): Promise<TaskIssue[]> {
    const issues = await this.runJson<GitHubIssueJson[]>(
      [
        "issue",
        "list",
        "--repo",
        this.repository,
        "--state",
        state,
        "--limit",
        "1000",
        "--json",
        "number,title,state,labels,url",
      ],
      "Could not list GitHub issues.",
    );
    return issues.map(toTaskIssue);
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

  async createIssue(options: {
    title: string;
    body: string;
    label: string;
  }): Promise<TaskIssue> {
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
    return toTaskIssue(issue);
  }

  async updateIssue(
    issueNumber: number,
    update: IssueUpdate,
  ): Promise<TaskIssue> {
    const args = [
      "api",
      "--method",
      "PATCH",
      `repos/${this.repository}/issues/${issueNumber}`,
      "--raw-field",
      `title=${update.title}`,
      "--raw-field",
      `state=${update.state}`,
    ];
    for (const label of update.labels) {
      args.push("--raw-field", `labels[]=${label}`);
    }

    const issue = await this.runJson<GitHubIssueJson>(
      args,
      `Could not update issue #${issueNumber}.`,
    );
    return toTaskIssue(issue);
  }
}
