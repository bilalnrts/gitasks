import { normalizeStatus, type TaskStatus } from "../tasks/statuses.js";
import { errorMessage } from "../utils/errors.js";

export const MAX_BODY_BYTES = 64 * 1024;

export class RequestValidationError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

export function rejectUnknownKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new RequestValidationError(400, `Unknown field: ${unknown}`);
}

export function requiredText(input: Record<string, unknown>, key: string, label: string, max = 256): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new RequestValidationError(400, `${label} is required.`);
  const trimmed = value.trim();
  if (Array.from(trimmed).length > max) throw new RequestValidationError(400, `${label} must be ${max} characters or fewer.`);
  return trimmed;
}

export function optionalText(input: Record<string, unknown>, key: string, label: string, maxBytes = MAX_BODY_BYTES): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new RequestValidationError(400, `${label} must be a string.`);
  if (Buffer.byteLength(value) > maxBytes) throw new RequestValidationError(400, `${label} is too large.`);
  return value;
}

export function optionalTitle(input: Record<string, unknown>, key: string, label: string, max = 256): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new RequestValidationError(400, `${label} must be a string.`);
  if (Array.from(value.trim()).length > max) throw new RequestValidationError(400, `${label} must be ${max} characters or fewer.`);
  return value;
}

export function optionalNullableNumber(input: Record<string, unknown>, key: string, label: string): number | null | undefined {
  const value = input[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new RequestValidationError(400, `${label} must be a positive integer or null.`);
  return value;
}

export function requiredBoolean(input: Record<string, unknown>, key: string, label: string): boolean {
  const value = input[key];
  if (typeof value !== "boolean") throw new RequestValidationError(400, `${label} is required.`);
  return value;
}

export function requiredLogin(input: Record<string, unknown>): string {
  const login = requiredText(input, "login", "GitHub login", 39);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) throw new RequestValidationError(400, "GitHub login is invalid.");
  return login;
}

export function requiredIssueNumber(input: Record<string, unknown>): number {
  const value = input.issueNumber;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new RequestValidationError(400, "Issue number must be a positive integer.");
  return value;
}

export function requiredStatus(input: Record<string, unknown>): TaskStatus {
  if (typeof input.status !== "string") throw new RequestValidationError(400, "Task status is required.");
  try { return normalizeStatus(input.status); }
  catch (error) { throw new RequestValidationError(400, errorMessage(error)); }
}

export function requiredEnum<T extends string>(input: Record<string, unknown>, key: string, label: string, values: readonly T[]): T {
  const value = input[key];
  if (typeof value !== "string" || !values.includes(value as T)) throw new RequestValidationError(400, `${label} must be one of: ${values.join(", ")}.`);
  return value as T;
}

export function optionalDate(input: Record<string, unknown>, key: string): string | null | undefined {
  const value = input[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RequestValidationError(400, "Due date must use YYYY-MM-DD or null.");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw new RequestValidationError(400, "Due date must be a real calendar date.");
  return value;
}

export function parsePage(value: string | null): number {
  if (value === null) return 1;
  if (!/^[1-9]\d*$/.test(value)) throw new RequestValidationError(400, "Page must be a positive integer.");
  const page = Number(value);
  if (!Number.isSafeInteger(page)) throw new RequestValidationError(400, "Page must be a positive integer.");
  return page;
}
