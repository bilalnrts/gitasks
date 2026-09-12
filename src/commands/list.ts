import type { GitHubClient } from "../github/client.js";
import { taskStatus, taskTitle } from "../tasks/service.js";
import { normalizeStatus, type TaskStatus } from "../tasks/statuses.js";

export interface ListOptions {
  status?: string;
}

export async function listTasks(
  client: Pick<GitHubClient, "listIssues">,
  options: ListOptions,
): Promise<string> {
  const statusFilter: TaskStatus | undefined =
    options.status === undefined ? undefined : normalizeStatus(options.status);
  const issues = await client.listIssues(statusFilter === undefined ? "open" : "all");
  const tasks = issues
    .map((issue) => ({ issue, status: taskStatus(issue), title: taskTitle(issue) }))
    .filter(({ status }) =>
      statusFilter === undefined ? status !== "DONE" : status === statusFilter,
    );

  if (tasks.length === 0) {
    return "No tasks found.";
  }

  const numberWidth = Math.max(...tasks.map(({ issue }) => `#${issue.number}`.length));
  const statusWidth = "[IN PROGRESS]".length;
  return tasks
    .map(({ issue, status, title }) =>
      `${`#${issue.number}`.padEnd(numberWidth)}  ${`[${status}]`.padEnd(statusWidth)}  ${title}`,
    )
    .join("\n");
}
