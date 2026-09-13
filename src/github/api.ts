import { CommandError, UserError, errorMessage } from "../utils/errors.js";
import type { CommandRunner } from "../utils/exec.js";

export const REST_HEADERS = [
  "-H",
  "Accept: application/vnd.github+json",
  "-H",
  "X-GitHub-Api-Version: 2026-03-10",
] as const;

export class GitHubApiError extends UserError {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly stateVerified = false,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export class AmbiguousMilestoneCreateError extends GitHubApiError {
  constructor(message: string, readonly title: string, readonly recoveryUrl: string) {
    super(message, "ambiguous-milestone-create", false, false);
    this.name = "AmbiguousMilestoneCreateError";
  }
}

function statusFromMessage(message: string): number | undefined {
  const match = /\b(?:HTTP\s+)?([1-5]\d\d)\b/i.exec(message);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function classifyError(context: string, error: unknown, mutation: boolean, unsupportedOnNotFound = false): GitHubApiError {
  const detail = errorMessage(error);
  const status = statusFromMessage(detail);
  if (error instanceof Error && error.name === "AbortError") {
    return new GitHubApiError(`${context}\n\nThe request was cancelled.`, "aborted", true, true);
  }
  if (error instanceof CommandError && error.causeCode === "ABORT_ERR") {
    return new GitHubApiError(`${context}\n\nThe request was cancelled.`, "aborted", true, true);
  }
  if (error instanceof CommandError && error.causeCode === "ENOENT") {
    return new GitHubApiError(`${context}\n\n${detail}`, "gh-unavailable", false, true);
  }
  if (status === 401) return new GitHubApiError(`${context}\n\n${detail}`, "authentication", false, true, status);
  if (status === 429 || (status === 403 && /\b(?:api |secondary )?rate limit\b|abuse detection/i.test(detail))) {
    return new GitHubApiError(`${context}\n\n${detail}`, "rate-limit", true, true, status);
  }
  if (status === 403) return new GitHubApiError(`${context}\n\n${detail}`, "permission", false, true, status);
  if (status === 404) return new GitHubApiError(`${context}\n\n${detail}`, unsupportedOnNotFound ? "unsupported" : "not-found", false, true, status);
  if (status === 415) return new GitHubApiError(`${context}\n\n${detail}`, "unsupported", false, true, status);
  if (status === 409) return new GitHubApiError(`${context}\n\n${detail}`, "conflict", false, true, status);
  if (status === 400 || status === 422) return new GitHubApiError(`${context}\n\n${detail}`, "validation", false, true, status);
  const definite = status !== undefined && status >= 400 && status < 500;
  return new GitHubApiError(`${context}\n\n${detail}`, mutation && !definite ? "ambiguous" : "github", !mutation && !definite, definite, status);
}

export interface RestOptions {
  method?: string;
  fields?: ReadonlyArray<readonly [string, string]>;
  typedFields?: ReadonlyArray<readonly [string, string]>;
  mutation?: boolean;
  unsupportedOnNotFound?: boolean;
  signal?: AbortSignal | undefined;
}

export interface RestResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}

export interface PageResult {
  items: unknown[];
  complete: boolean;
  pages: number;
}

export class GitHubApi {
  constructor(readonly repository: string, private readonly runner: CommandRunner) {}

  private restArgs(path: string, method?: string): string[] {
    const args = ["api", ...REST_HEADERS];
    if (method !== undefined) args.push("--method", method);
    args.push(path);
    return args;
  }

  async restRaw(path: string, context: string, options: RestOptions = {}): Promise<string> {
    const args = this.restArgs(path, options.method);
    for (const [name, value] of options.fields ?? []) args.push("--raw-field", `${name}=${value}`);
    for (const [name, value] of options.typedFields ?? []) args.push("--field", `${name}=${value}`);
    try {
      return (await this.runner("gh", args, { signal: options.signal })).stdout;
    } catch (error) {
      throw classifyError(context, error, options.mutation ?? options.method !== undefined, options.unsupportedOnNotFound);
    }
  }
  async restResponse(path: string, context: string, options: RestOptions = {}): Promise<RestResponse> {
    const args = this.restArgs(path, options.method);
    args.splice(1, 0, "--include");
    for (const [name, value] of options.fields ?? []) args.push("--raw-field", `${name}=${value}`);
    for (const [name, value] of options.typedFields ?? []) args.push("--field", `${name}=${value}`);
    let stdout: string;
    try {
      stdout = (await this.runner("gh", args, { signal: options.signal })).stdout.replace(/\r\n/g, "\n");
    } catch (error) {
      throw classifyError(context, error, options.mutation ?? options.method !== undefined, options.unsupportedOnNotFound);
    }
    const matches = [...stdout.matchAll(/^HTTP\/\S+\s+(\d{3})[^\n]*\n/gm)];
    const last = matches.at(-1);
    if (last === undefined || last.index === undefined || last[1] === undefined) {
      throw new GitHubApiError(`${context}\n\nGitHub CLI returned an unexpected response.`, "invalid-response", false, false);
    }
    const response = stdout.slice(last.index);
    const boundary = response.indexOf("\n\n");
    if (boundary < 0) throw new GitHubApiError(`${context}\n\nGitHub CLI returned malformed response headers.`, "invalid-response", false, false);
    const headerLines = response.slice(0, boundary).split("\n").slice(1);
    const headers: Record<string, string> = {};
    for (const line of headerLines) {
      const separator = line.indexOf(":");
      if (separator > 0) headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    }
    return { status: Number(last[1]), headers, body: response.slice(boundary + 2) };
  }

  async restJsonResponse(path: string, context: string, options: RestOptions = {}): Promise<{ status: number; headers: Readonly<Record<string, string>>; value: unknown }> {
    const response = await this.restResponse(path, context, options);
    if (response.status === 202 || response.status === 204) return { status: response.status, headers: response.headers, value: null };
    try {
      return { status: response.status, headers: response.headers, value: JSON.parse(response.body) as unknown };
    } catch {
      throw new GitHubApiError(`${context}\n\nGitHub CLI returned an unexpected response.`, options.mutation ?? options.method !== undefined ? "ambiguous" : "invalid-response", false, false, response.status);
    }
  }

  async restJson(path: string, context: string, options: RestOptions = {}): Promise<unknown> {
    const stdout = await this.restRaw(path, context, options);
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new GitHubApiError(`${context}\n\nGitHub CLI returned an unexpected response.`, options.mutation ?? options.method !== undefined ? "ambiguous" : "invalid-response", false, false);
    }
  }

  async graphql(query: string, variables: ReadonlyArray<readonly [string, string]>, context: string, mutation = false, signal?: AbortSignal): Promise<unknown> {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [name, value] of variables) args.push("-F", `${name}=${value}`);
    try {
      const stdout = (await this.runner("gh", args, { signal })).stdout;
      try {
        return JSON.parse(stdout) as unknown;
      } catch {
        throw new GitHubApiError(`${context}\n\nGitHub CLI returned an unexpected response.`, mutation ? "ambiguous" : "invalid-response", false, false);
      }
    } catch (error) {
      if (error instanceof GitHubApiError) throw error;
      throw classifyError(context, error, mutation);
    }
  }

  async pages(path: string, context: string, options: Pick<RestOptions, "unsupportedOnNotFound" | "signal"> & { maxPages?: number } = {}): Promise<PageResult> {
    const separator = path.includes("?") ? "&" : "?";
    const result: unknown[] = [];
    const stableIds = new Set<string>();
    const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
    for (let page = 1; page <= maxPages; page += 1) {
      const value = await this.restJson(`${path}${separator}per_page=100&page=${page}`, context, options);
      if (!Array.isArray(value)) throw new GitHubApiError(`${context}\n\nGitHub CLI returned an unexpected response.`, "invalid-response", false, false);
      for (const item of value) {
        const object = item !== null && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
        const rawId = object?.id ?? object?.node_id;
        if (typeof rawId === "number" || typeof rawId === "string") {
          const id = `${typeof rawId}:${String(rawId)}`;
          if (stableIds.has(id)) continue;
          stableIds.add(id);
        }
        result.push(item);
      }
      if (value.length < 100) return { items: result, complete: true, pages: page };
      if (page === maxPages) return { items: result, complete: false, pages: page };
    }
    return { items: result, complete: true, pages: 0 };
  }

  async allPages(path: string, context: string, options: Pick<RestOptions, "unsupportedOnNotFound" | "signal"> = {}): Promise<unknown[]> {
    return (await this.pages(path, context, options)).items;
  }
}

export function expectObject(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new GitHubApiError(`${context}\n\nGitHub returned an invalid object.`, "invalid-response", false);
  return value as Record<string, unknown>;
}

export function expectArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new GitHubApiError(`${context}\n\nGitHub returned an invalid list.`, "invalid-response", false);
  return value;
}

export function requiredString(value: unknown, field: string, context: string): string {
  if (typeof value !== "string") throw new GitHubApiError(`${context}\n\nGitHub omitted ${field}.`, "invalid-response", false);
  return value;
}

export function requiredNumber(value: unknown, field: string, context: string): number {
  if (!Number.isSafeInteger(value)) throw new GitHubApiError(`${context}\n\nGitHub omitted ${field}.`, "invalid-response", false);
  return value as number;
}
