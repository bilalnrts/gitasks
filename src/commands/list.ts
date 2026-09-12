import type { GitHubClient } from "../github/client.js";
import {
  normalizeIssueStateFilter,
  taskStatus,
  taskTitle,
} from "../tasks/service.js";
import { normalizeStatus, type TaskStatus } from "../tasks/statuses.js";
import type { IssueStateFilter } from "../tasks/types.js";

export interface ListOptions {
  status?: string;
  state?: string;
}

export async function listTasks(
  client: Pick<GitHubClient, "listIssues">,
  options: ListOptions,
): Promise<string> {
  const statusFilter: TaskStatus | null | undefined =
    options.status === undefined
      ? undefined
      : options.status.trim().toLowerCase() === "unclassified"
        ? null
        : normalizeStatus(options.status);
  const stateFilter: IssueStateFilter = normalizeIssueStateFilter(
    options.state ?? "open",
  );
  const issues = await client.listIssues(stateFilter);
  const tasks = issues
    .map((issue) => ({ issue, status: taskStatus(issue) ?? null, title: taskTitle(issue) }))
    .filter(({ status }) => statusFilter === undefined || status === statusFilter);

  if (tasks.length === 0) {
    return "No tasks found.";
  }

  const numberWidth = Math.max(...tasks.map(({ issue }) => `#${issue.number}`.length));
  const statusWidth = "[UNCLASSIFIED]".length;
  return tasks
    .map(({ issue, status, title }) =>
      `${`#${issue.number}`.padEnd(numberWidth)}  ${`[${status ?? "UNCLASSIFIED"}]`.padEnd(statusWidth)}  [${issue.state}]  ${title}`,
    )
    .join("\n");
}
