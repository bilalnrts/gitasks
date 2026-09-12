import { formatTaskTitle, inferTaskStatus, stripTaskStatusPrefixes } from "./parser.js";
import { isStatusLabel, normalizeStatus, statusLabel, type TaskStatus } from "./statuses.js";
import type { IssueStateFilter, TaskCreator, TaskGateway, TaskIssue } from "./types.js";
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

export function taskStatus(issue: TaskIssue): TaskStatus | undefined {
  return inferTaskStatus(issue.labels, issue.title);
}

export function normalizeIssueStateFilter(value: string): IssueStateFilter {
  const normalized = value.trim().toLowerCase();
  if (normalized === "open" || normalized === "closed" || normalized === "all") {
    return normalized;
  }
  throw new UserError(
    `Invalid issue state: ${value}\n\nValid states:\n- open\n- closed\n- all`,
  );
}

export interface CreateTaskOptions {
  status?: string;
  body?: string;
  assignees?: string[];
  milestone?: number | null;
}

export async function createTaskIssue(
  gateway: TaskCreator,
  titleInput: string,
  options: CreateTaskOptions,
): Promise<TaskIssue> {
  const title = stripTaskStatusPrefixes(titleInput);
  if (title.length === 0) {
    throw new UserError("Task title cannot be empty.");
  }

  const status = normalizeStatus(options.status ?? "backlog");
  const input = {
    title: formatTaskTitle(title, status),
    body: options.body ?? "",
    label: statusLabel(status),
    state: status === "DONE" ? "closed" as const : "open" as const,
    ...(options.assignees === undefined ? {} : { assignees: options.assignees }),
    ...(options.milestone === undefined ? {} : { milestone: options.milestone }),
  };
  return gateway.createIssue(input);
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
