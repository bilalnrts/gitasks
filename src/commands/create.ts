import type { GitHubClient } from "../github/client.js";
import { createTaskIssue, type CreateTaskOptions } from "../tasks/service.js";

export interface CreateOptions extends CreateTaskOptions {}

export async function createTask(
  client: GitHubClient,
  titleInput: string,
  options: CreateOptions,
): Promise<string> {
  const issue = await createTaskIssue(client, titleInput, options);

  return `Created task #${issue.number}\n${issue.title}\n${issue.url}`;
}
