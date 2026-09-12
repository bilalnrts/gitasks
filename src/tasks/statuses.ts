import { UserError } from "../utils/errors.js";

export const STATUS_DEFINITIONS = [
  { name: "BACKLOG", slug: "backlog", label: "status:backlog", color: "BFD4F2" },
  { name: "TODO", slug: "todo", label: "status:todo", color: "FBCA04" },
  {
    name: "IN PROGRESS",
    slug: "in-progress",
    label: "status:in-progress",
    color: "1D76DB",
  },
  { name: "REVIEW", slug: "review", label: "status:review", color: "A371F7" },
  { name: "DONE", slug: "done", label: "status:done", color: "0E8A16" },
  { name: "BLOCKED", slug: "blocked", label: "status:blocked", color: "D73A4A" },
] as const;

export type TaskStatus = (typeof STATUS_DEFINITIONS)[number]["name"];
export type StatusSlug = (typeof STATUS_DEFINITIONS)[number]["slug"];

export const TASK_STATUSES = STATUS_DEFINITIONS.map(({ name }) => name);

function comparableStatus(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function tryNormalizeStatus(value: string): TaskStatus | undefined {
  const comparable = comparableStatus(value);
  return STATUS_DEFINITIONS.find(
    ({ name, slug, label }) =>
      comparable === comparableStatus(name) ||
      comparable === slug ||
      comparable === label,
  )?.name;
}

export function normalizeStatus(value: string): TaskStatus {
  const status = tryNormalizeStatus(value);
  if (status === undefined) {
    throw new UserError(
      `Invalid status: ${value}\n\nValid statuses:\n${STATUS_DEFINITIONS.map(({ slug }) => `- ${slug}`).join("\n")}`,
    );
  }
  return status;
}

export function statusDefinition(status: TaskStatus) {
  return STATUS_DEFINITIONS.find(({ name }) => name === status)!;
}

export function statusLabel(status: TaskStatus): string {
  return statusDefinition(status).label;
}

export function statusFromLabel(label: string): TaskStatus | undefined {
  return STATUS_DEFINITIONS.find(
    ({ label: expected }) => expected.toLowerCase() === label.trim().toLowerCase(),
  )?.name;
}

export function isStatusLabel(label: string): boolean {
  return label.trim().toLowerCase().startsWith("status:");
}
