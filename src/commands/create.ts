import type { GitHubClient } from "../github/client.js";
import { formatTaskTitle, stripTaskStatusPrefixes } from "../tasks/parser.js";
import { normalizeStatus, statusLabel } from "../tasks/statuses.js";
import { UserError } from "../utils/errors.js";

export interface CreateOptions {
  status?: string;
  body?: string;
}

export async function createTask(
  client: GitHubClient,
  titleInput: string,
  options: CreateOptions,
): Promise<string> {
  const title = stripTaskStatusPrefixes(titleInput);
  if (title.length === 0) {
    throw new UserError("Task title cannot be empty.");
  }

  const status = normalizeStatus(options.status ?? "backlog");
  const issue = await client.createIssue({
    title: formatTaskTitle(title, status),
    body: options.body ?? "",
    label: statusLabel(status),
  });

  return `Created task #${issue.number}\n${issue.title}\n${issue.url}`;
}
