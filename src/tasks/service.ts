import { formatTaskTitle, inferTaskStatus, stripTaskStatusPrefixes } from "./parser.js";
import { isStatusLabel, statusLabel, type TaskStatus } from "./statuses.js";
import type { TaskGateway, TaskIssue } from "./types.js";
import { UserError } from "../utils/errors.js";

export function parseIssueNumber(value: string): number {
  const match = /^#?([1-9]\d*)$/.exec(value.trim());
  if (match?.[1] === undefined) {
    throw new UserError(
      `Invalid issue number: ${value}\n\nUse a positive number such as 42 or #42.`,
    );
  }
  return Number(match[1]);
}

export function taskTitle(issue: TaskIssue): string {
  return stripTaskStatusPrefixes(issue.title);
}

export function taskStatus(issue: TaskIssue): TaskStatus {
  return inferTaskStatus(issue.labels, issue.title);
}

export async function transitionTask(
  gateway: TaskGateway,
  issueInput: string,
  status: TaskStatus,
): Promise<TaskIssue> {
  const issueNumber = parseIssueNumber(issueInput);
  const issue = await gateway.getIssue(issueNumber);
  const title = formatTaskTitle(issue.title, status);

  return gateway.transitionIssue(issueNumber, {
    title,
    previousStatusLabels: issue.labels.filter(isStatusLabel),
    nextStatusLabel: statusLabel(status),
    state: status === "DONE" ? "closed" : "open",
  });
}
