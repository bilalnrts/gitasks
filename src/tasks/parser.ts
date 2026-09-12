import {
  STATUS_DEFINITIONS,
  statusFromLabel,
  tryNormalizeStatus,
  type TaskStatus,
} from "./statuses.js";

export interface ParsedTaskTitle {
  status?: TaskStatus;
  title: string;
}

const STATUS_PREFIX = /^\s*\[\s*([^\]]+?)\s*\]\s*/;

export function parseTaskTitle(value: string): ParsedTaskTitle {
  const match = STATUS_PREFIX.exec(value);
  if (match === null) {
    return { title: value.trim() };
  }

  const statusText = match[1];
  if (statusText === undefined) {
    return { title: value.trim() };
  }

  const status = tryNormalizeStatus(statusText);
  if (status === undefined) {
    return { title: value.trim() };
  }

  return {
    status,
    title: value.slice(match[0].length).trim(),
  };
}

export function stripTaskStatusPrefixes(value: string): string {
  let title = value.trim();

  while (true) {
    const parsed = parseTaskTitle(title);
    if (parsed.status === undefined) {
      return title;
    }
    title = parsed.title;
  }
}

export function formatTaskTitle(title: string, status: TaskStatus): string {
  const cleanTitle = stripTaskStatusPrefixes(title);
  return cleanTitle.length === 0 ? `[${status}]` : `[${status}] ${cleanTitle}`;
}

export function inferTaskStatus(
  labels: readonly string[],
  title: string,
): TaskStatus {
  const labeledStatuses: TaskStatus[] = [];
  for (const label of labels) {
    const status = statusFromLabel(label);
    if (status !== undefined && !labeledStatuses.includes(status)) {
      labeledStatuses.push(status);
    }
  }

  const titleStatus = parseTaskTitle(title).status;
  if (labeledStatuses.length === 0) {
    return titleStatus ?? "BACKLOG";
  }
  if (titleStatus !== undefined && labeledStatuses.includes(titleStatus)) {
    return titleStatus;
  }

  return STATUS_DEFINITIONS.find(({ name }) => labeledStatuses.includes(name))!.name;
}
