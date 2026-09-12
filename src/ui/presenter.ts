import { isStatusLabel, type TaskStatus } from "../tasks/statuses.js";
import { taskStatus, taskTitle } from "../tasks/service.js";
import type { TaskIssue } from "../tasks/types.js";

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

export function presentTask(issue: TaskIssue): BoardTask {
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
