import { isStatusLabel, type TaskStatus } from "../tasks/statuses.js";
import { taskStatus, taskTitle } from "../tasks/service.js";
import type { TaskIssue } from "../tasks/types.js";
import type { TaskSummary, UserSummary } from "../workspace/types.js";

export interface BoardTask {
  number: number;
  status: TaskStatus | null;
  title: string;
  fullTitle: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  assignees: string[];
  url: string;
}

export function presentTaskSummary(issue: TaskIssue): TaskSummary {
  const assignees: UserSummary[] = issue.assigneeUsers ?? issue.assignees.map((login) => ({
    login,
    avatarUrl: "",
    url: `https://github.com/${encodeURIComponent(login)}`,
  }));
  return {
    id: issue.id ?? 0,
    nodeId: issue.nodeId ?? "",
    number: issue.number,
    status: taskStatus(issue) ?? null,
    title: taskTitle(issue),
    fullTitle: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.filter((label) => !isStatusLabel(label)),
    assignees,
    url: issue.url,
    createdAt: issue.createdAt ?? "",
    updatedAt: issue.updatedAt ?? "",
    author: issue.author ?? null,
    milestone: issue.milestone ?? null,
  };
}

export function presentTask(issue: TaskIssue): BoardTask | TaskSummary {
  if (issue.id !== undefined || issue.nodeId !== undefined || issue.createdAt !== undefined) {
    return presentTaskSummary(issue);
  }
  return {
    number: issue.number,
    status: taskStatus(issue) ?? null,
    title: taskTitle(issue),
    fullTitle: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.filter((label) => !isStatusLabel(label)),
    assignees: issue.assignees,
    url: issue.url,
  };
}
