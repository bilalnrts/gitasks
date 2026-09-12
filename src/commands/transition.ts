import type { GitHubClient } from "../github/client.js";
import { transitionTask } from "../tasks/service.js";
import type { TaskStatus } from "../tasks/statuses.js";

export async function moveTask(
  client: GitHubClient,
  issueInput: string,
  status: TaskStatus,
): Promise<string> {
  const issue = await transitionTask(client, issueInput, status);
  return `Task #${issue.number} moved to ${status}\n${issue.title}`;
}
