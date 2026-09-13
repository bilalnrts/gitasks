import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AnalyticsQueryError, AnalyticsService } from "../analytics/service.js";
import type { AnalyticsDataset, AnalyticsQuery, AnalyticsSection } from "../analytics/types.js";
import { createTaskIssue, normalizeIssueStateFilter, transitionTask } from "../tasks/service.js";
import { STATUS_DEFINITIONS } from "../tasks/statuses.js";
import type { CreateIssueInput, IssueStateFilter, TaskCreator, TaskGateway, TaskIssue } from "../tasks/types.js";
import type {
  ActivityEvent,
  ListPage,
  MergeMethod,
  MilestoneItems,
  MilestoneSummary,
  OverviewPayload,
  PullRequestDetail,
  PullRequestSummary,
  TaskDetail,
  TaskSummary,
  UserSummary,
  WorkspaceContext,
} from "../workspace/types.js";
import { AmbiguousMilestoneCreateError, GitHubApiError } from "../github/api.js";
import { AmbiguousCreateError, errorMessage, PartialCreateError, UserError } from "../utils/errors.js";
import { KeyedMutationQueue } from "./mutations.js";
import { presentTask, presentTaskSummary } from "./presenter.js";
import {
  MAX_BODY_BYTES,
  RequestValidationError,
  optionalDate,
  optionalNullableNumber,
  optionalText,
  optionalTitle,
  parsePage,
  rejectUnknownKeys,
  requiredBoolean,
  requiredEnum,
  requiredIssueNumber,
  requiredLogin,
  requiredStatus,
  requiredText,
} from "./validation.js";

export const DEFAULT_UI_PORT = 4317;
export const UI_HOST = "127.0.0.1";
const CSRF_PLACEHOLDER = "__GITASKS_CSRF_TOKEN__";
const SHELL_ROUTES: Record<string, true> = {
  "/": true,
  "/index.html": true,
  "/overview": true,
  "/tasks": true,
  "/activity": true,
  "/pull-requests": true,
  "/milestones": true,
  "/analytics": true,
};

export interface BoardGateway extends TaskGateway, TaskCreator {
  listIssues(state: IssueStateFilter): Promise<TaskIssue[]>;
  getContext?(): Promise<WorkspaceContext>;
  listIssuePage?(state: IssueStateFilter, page: number): Promise<ListPage<TaskSummary>>;
  getIssueDetail?(number: number): Promise<TaskDetail>;
  updateIssue?(number: number, input: { title?: string; body?: string; milestone?: number | null }): Promise<TaskIssue>;
  listAssignees?(): Promise<UserSummary[]>;
  mutateIssueAssignee?(number: number, login: string, add: boolean): Promise<TaskIssue>;
  mutateSubIssue?(number: number, issueNumber: number, add: boolean): Promise<TaskDetail>;
  mutateBlockedBy?(number: number, issueNumber: number, add: boolean): Promise<TaskDetail>;
  listMilestones?(state: "open" | "closed" | "all"): Promise<ListPage<MilestoneSummary>>;
  createMilestone?(input: { title: string; description?: string; dueOn?: string | null }): Promise<MilestoneSummary>;
  updateMilestone?(number: number, input: { title?: string; description?: string; dueOn?: string | null; state?: "open" | "closed" }): Promise<MilestoneSummary>;
  getMilestoneItems?(number: number): Promise<MilestoneItems>;
  listBranches?(): Promise<string[]>;
  listPullRequests?(state: "open" | "closed" | "merged" | "all", page: number): Promise<ListPage<PullRequestSummary>>;
  createPullRequest?(input: { title: string; body: string; head: string; base: string; draft: boolean }): Promise<PullRequestSummary>;
  getPullRequest?(number: number): Promise<PullRequestSummary>;
  getPullRequestDetail?(number: number): Promise<PullRequestDetail>;
  updatePullRequest?(number: number, input: { title?: string; body?: string; state?: "open" | "closed"; milestone?: number | null }): Promise<PullRequestSummary>;
  mutatePullAssignee?(number: number, login: string, add: boolean): Promise<PullRequestSummary>;
  setPullDraft?(number: number, draft: boolean): Promise<PullRequestSummary>;
  mutateReviewer?(number: number, login: string, add: boolean): Promise<PullRequestDetail>;
  createReview?(number: number, event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string): Promise<PullRequestDetail>;
  mergePullRequest?(number: number, method: MergeMethod, expectedHeadSha: string): Promise<PullRequestSummary>;
  listActivity?(page: number): Promise<ListPage<ActivityEvent>>;
  getOverview?(): Promise<OverviewPayload>;
  loadAnalyticsDataset?(scope?: "current" | AnalyticsSection, signal?: AbortSignal, query?: AnalyticsQuery): Promise<AnalyticsDataset>;
}

export interface UiServerOptions {
  repository: string;
  gateway: BoardGateway;
  port: number;
  assetDirectory?: string;
  csrfToken?: string;
}

export interface RunningUiServer {
  server: Server;
  port: number;
  url: string;
  csrfToken: string;
  close(): Promise<void>;
}

interface UiAssets { html: string; javascript: Buffer; css: Buffer }

class HttpError extends Error {
  constructor(readonly statusCode: number, message: string, readonly code = "request") {
    super(message);
    this.name = "HttpError";
  }
}

export function parseUiPort(value: string): number {
  if (!/^\d+$/.test(value)) throw new UserError(`Invalid port: ${value}\n\nUse an integer between 1 and 65535.`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new UserError(`Invalid port: ${value}\n\nUse an integer between 1 and 65535.`);
  return port;
}

export function resolveUiAssetDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const packagedDirectory = join(moduleDirectory, "ui");
  if (existsSync(packagedDirectory)) return packagedDirectory;
  return join(moduleDirectory, "..", "..", "dist", "ui");
}

export async function loadUiAssets(directory: string): Promise<UiAssets> {
  try {
    const [html, javascript, css] = await Promise.all([readFile(join(directory, "index.html"), "utf8"), readFile(join(directory, "app.js")), readFile(join(directory, "styles.css"))]);
    if (!html.includes(CSRF_PLACEHOLDER)) throw new Error("index.html is missing its CSRF placeholder");
    return { html, javascript, css };
  } catch (error) {
    throw new UserError(`Gitasks UI assets could not be loaded from ${directory}.\n\nRun:\nnpm run build\n\n${errorMessage(error)}`);
  }
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  applySecurityHeaders(response);
  response.writeHead(statusCode, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

function sendText(response: ServerResponse, statusCode: number, contentType: string, body: string | Buffer, cacheControl: string): void {
  applySecurityHeaders(response);
  response.writeHead(statusCode, { "Cache-Control": cacheControl, "Content-Type": contentType, "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function safeTokenMatch(received: string | undefined, expected: string): boolean {
  if (received === undefined) return false;
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

function validateRequestSource(request: IncomingMessage, authority: string, csrfToken: string): void {
  if (headerValue(request, "host")?.toLowerCase() !== authority) throw new HttpError(403, "Request host is not allowed.", "host");
  const origin = headerValue(request, "origin");
  const expectedOrigin = `http://${authority}`;
  if (origin !== undefined && origin !== expectedOrigin) throw new HttpError(403, "Cross-origin requests are not allowed.", "origin");
  if (request.method !== "GET" && request.method !== "HEAD") {
    if (origin !== expectedOrigin) throw new HttpError(403, "Mutating requests require the local UI origin.", "origin");
    if (!safeTokenMatch(headerValue(request, "x-gitasks-csrf"), csrfToken)) throw new HttpError(403, "Invalid or missing CSRF token.", "csrf");
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = headerValue(request, "content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new HttpError(415, "Content-Type must be application/json.", "content-type");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large.", "body-too-large");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "Request body must contain valid JSON.", "json"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "Request body must be a JSON object.", "json");
  return parsed as Record<string, unknown>;
}

function parseCreateInput(input: Record<string, unknown>): { title: string; body: string; status: string; assignees?: string[]; milestone?: number | null } {
  rejectUnknownKeys(input, ["title", "body", "status", "assignees", "milestone"]);
  const title = requiredText(input, "title", "Task title");
  const body = optionalText(input, "body", "Task description") ?? "";
  let status = "backlog";
  if (input.status !== undefined) {
    if (typeof input.status !== "string") throw new RequestValidationError(400, "Task status must be a string.");
    requiredStatus({ status: input.status });
    status = input.status;
  }
  let assignees: string[] | undefined;
  if (input.assignees !== undefined) {
    if (!Array.isArray(input.assignees) || input.assignees.length > 10) throw new RequestValidationError(400, "Assignees must be an array of at most 10 GitHub logins.");
    assignees = input.assignees.map((login) => requiredLogin({ login }));
    if (new Set(assignees).size !== assignees.length) throw new RequestValidationError(400, "Assignees must not contain duplicates.");
  }
  const milestone = optionalNullableNumber(input, "milestone", "Milestone");
  const result: { title: string; body: string; status: string; assignees?: string[]; milestone?: number | null } = { title, body, status };
  if (assignees !== undefined) result.assignees = assignees;
  if (milestone !== undefined) result.milestone = milestone;
  return result;
}

function issueNumberFromMatch(match: RegExpExecArray): number {
  const raw = match[1];
  if (raw === undefined) throw new HttpError(404, "Not found.");
  return Number(raw);
}

function ensureCapability(condition: boolean, feature: string): void {
  if (!condition) throw new HttpError(501, `${feature} is not supported by this GitHub gateway.`, "unsupported");
}

function boardPayload(repository: string, state: IssueStateFilter, issues: TaskIssue[]) {
  return {
    repository,
    state,
    scope: `${state === "all" ? "Open and closed" : state === "open" ? "Open" : "Closed"} GitHub Issues; search covers every loaded issue; pull requests excluded`,
    complete: true,
    statuses: STATUS_DEFINITIONS.map(({ name, slug, color }) => ({ name, slug, color })),
    tasks: issues.map(presentTask),
  };
}

function errorPayload(error: unknown, stateVerified?: boolean) {
  const github = error instanceof GitHubApiError ? error : null;
  const code = github?.code ?? (error instanceof HttpError ? error.code : "github");
  const payload: { message: string; code: string; retryable: boolean; stateVerified: boolean; permission?: string; unsupported?: string } = {
    message: errorMessage(error),
    code,
    retryable: github?.retryable ?? !(error instanceof HttpError),
    stateVerified: stateVerified ?? github?.stateVerified ?? false,
  };
  if (code === "permission" || code === "authentication") payload.permission = errorMessage(error);
  if (code === "unsupported") payload.unsupported = errorMessage(error);
  return payload;
}

function createRequestHandler(options: Omit<UiServerOptions, "port" | "assetDirectory" | "csrfToken">, assets: UiAssets, csrfToken: string, getAuthority: () => string) {
  const mutations = new KeyedMutationQueue();
  const analyticsGateway = options.gateway.loadAnalyticsDataset === undefined ? null : {
    loadAnalyticsDataset: (scope?: "current" | AnalyticsSection, signal?: AbortSignal, query?: AnalyticsQuery) => options.gateway.loadAnalyticsDataset!(scope, signal, query),
  };
  const analytics = analyticsGateway === null ? null : new AnalyticsService({
    repository: options.repository,
    gateway: analyticsGateway,
    authenticatedUser: options.gateway.getContext === undefined
      ? async () => "unknown-user"
      : async () => (await options.gateway.getContext!()).currentUser.login,
  });

  function runIssueRelationMutation<T>(firstNumber: number, secondNumber: number, action: () => Promise<T>): Promise<T> {
    const keys = [firstNumber, secondNumber].sort((left, right) => left - right).map((number) => `issue:${number}`);
    let ready = 0;
    let release!: () => void;
    let actionResult: Promise<T> | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const participants = keys.map((key) => mutations.run(key, async () => {
      ready += 1;
      if (ready === keys.length) {
        actionResult = Promise.resolve().then(action);
        release();
      }
      await gate;
      return actionResult!;
    }));
    return Promise.all(participants).then(([result]) => result!);
  }

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let trustedRequest = false;
    try {
      validateRequestSource(request, getAuthority(), csrfToken);
      trustedRequest = true;
      const requestUrl = new URL(request.url ?? "/", `http://${getAuthority()}`);
      const path = requestUrl.pathname;

      if (request.method === "GET" && (path === "/api/analytics/bootstrap" || path === "/api/analytics")) {
        const analyticsService = analytics;
        if (analyticsService === null) throw new HttpError(501, "Repository analytics is not supported by this GitHub gateway.", "unsupported");
        const controller = new AbortController();
        const abortRequest = (): void => controller.abort();
        request.once("aborted", abortRequest);
        response.once("close", abortRequest);
        if (request.destroyed || response.destroyed) controller.abort();
        try {
          await mutations.waitAll();
          if (controller.signal.aborted) return;
          const analyticsParams = new URLSearchParams(requestUrl.searchParams);
          const refreshValues = analyticsParams.getAll("refresh");
          if (refreshValues.length > 1 || (refreshValues.length === 1 && refreshValues[0] !== "1")) {
            throw new AnalyticsQueryError("Analytics refresh must be 1 when provided.");
          }
          analyticsParams.delete("refresh");
          const refresh = refreshValues.length === 1;
          const payload = path === "/api/analytics/bootstrap"
            ? await analyticsService.bootstrap(analyticsParams, controller.signal, refresh)
            : await analyticsService.section(analyticsParams, controller.signal, refresh);
          if (!response.destroyed) sendJson(response, 200, payload);
        } finally {
          request.removeListener("aborted", abortRequest);
          response.removeListener("close", abortRequest);
        }
        return;
      }

      if (request.method === "GET" && path === "/api/context") {
        ensureCapability(options.gateway.getContext !== undefined, "Workspace context");
        sendJson(response, 200, await options.gateway.getContext!());
        return;
      }

      if (request.method === "GET" && path === "/api/board") {
        await mutations.waitAll("issue:");
        let state: IssueStateFilter;
        try { state = normalizeIssueStateFilter(requestUrl.searchParams.get("state") ?? "open"); }
        catch (error) { throw new HttpError(400, errorMessage(error)); }
        const page = parsePage(requestUrl.searchParams.get("page"));
        if (options.gateway.listIssuePage !== undefined) {
          const result = await options.gateway.listIssuePage(state, page);
          sendJson(response, 200, {
            repository: options.repository,
            state,
            scope: `${state === "all" ? "Open and closed" : state === "open" ? "Open" : "Closed"} GitHub Issues; search covers loaded issues; pull requests excluded`,
            statuses: STATUS_DEFINITIONS.map(({ name, slug, color }) => ({ name, slug, color })),
            tasks: result.items,
            complete: result.complete,
            hasNext: result.hasNext,
            nextPage: result.nextPage,
            knownTotal: result.knownTotal,
          });
        } else {
          sendJson(response, 200, boardPayload(options.repository, state, await options.gateway.listIssues(state)));
        }
        return;
      }

      const issueMatch = /^\/api\/issues\/([1-9]\d*)$/.exec(path);
      if (request.method === "GET" && issueMatch !== null) {
        const number = issueNumberFromMatch(issueMatch);
        await mutations.wait(`issue:${number}`);
        if (options.gateway.getIssueDetail !== undefined) sendJson(response, 200, { detail: await options.gateway.getIssueDetail(number) });
        else sendJson(response, 200, { task: presentTask(await options.gateway.getIssue(number)) });
        return;
      }

      if (request.method === "POST" && path === "/api/issues") {
        const input = parseCreateInput(await readJsonBody(request));
        try {
          const issue = await createTaskIssue(options.gateway, input.title, input);
          sendJson(response, 201, { task: presentTask(issue) });
        } catch (error) {
          if (error instanceof PartialCreateError) {
            sendJson(response, 502, { error: { ...errorPayload(error), retryable: true }, task: presentTask(error.issue), repair: { issueNumber: error.issue.number, status: "DONE" } });
          } else if (error instanceof AmbiguousCreateError) {
            sendJson(response, 502, { error: { ...errorPayload(error), retryable: false }, recovery: { kind: "ambiguous-create", title: error.title, issuesUrl: error.recoveryUrl } });
          } else sendJson(response, 502, { error: errorPayload(error) });
        }
        return;
      }

      if (request.method === "PATCH" && issueMatch !== null) {
        const number = issueNumberFromMatch(issueMatch);
        const input = await readJsonBody(request);
        rejectUnknownKeys(input, ["title", "body", "milestone"]);
        ensureCapability(options.gateway.updateIssue !== undefined, "Issue editing");
        const title = optionalTitle(input, "title", "Task title");
        if (title !== undefined && title.trim().length === 0) throw new RequestValidationError(400, "Task title is required.");
        const body = optionalText(input, "body", "Task description");
        const milestone = optionalNullableNumber(input, "milestone", "Milestone");
        if (title === undefined && body === undefined && milestone === undefined) throw new RequestValidationError(400, "At least one issue field is required.");
        const update: { title?: string; body?: string; milestone?: number | null } = {};
        if (title !== undefined) update.title = title.trim();
        if (body !== undefined) update.body = body;
        if (milestone !== undefined) update.milestone = milestone;
        const issue = await mutations.run(`issue:${number}`, () => options.gateway.updateIssue!(number, update));
        sendJson(response, 200, { task: presentTaskSummary(issue) });
        return;
      }

      const statusMatch = /^\/api\/issues\/([1-9]\d*)\/status$/.exec(path);
      if (request.method === "POST" && statusMatch !== null) {
        const number = issueNumberFromMatch(statusMatch);
        const input = await readJsonBody(request);
        rejectUnknownKeys(input, ["status"]);
        const status = requiredStatus(input);
        await mutations.run(`issue:${number}`, async () => {
          try { sendJson(response, 200, { task: presentTask(await transitionTask(options.gateway, String(number), status)) }); }
          catch (operationError) {
            try { sendJson(response, 502, { error: errorPayload(operationError, true), task: presentTask(await options.gateway.getIssue(number)) }); }
            catch { sendJson(response, 502, { error: errorPayload(operationError, false) }); }
          }
        });
        return;
      }

      const assigneeMatch = /^\/api\/issues\/([1-9]\d*)\/assignees$/.exec(path);
      if ((request.method === "POST" || request.method === "DELETE") && assigneeMatch !== null) {
        const number = issueNumberFromMatch(assigneeMatch);
        const input = await readJsonBody(request);
        rejectUnknownKeys(input, ["login"]);
        const login = requiredLogin(input);
        ensureCapability(options.gateway.mutateIssueAssignee !== undefined, "Issue assignees");
        const issue = await mutations.run(`issue:${number}`, () => options.gateway.mutateIssueAssignee!(number, login, request.method === "POST"));
        sendJson(response, 200, { task: presentTaskSummary(issue) });
        return;
      }

      if (request.method === "GET" && path === "/api/assignees") {
        ensureCapability(options.gateway.listAssignees !== undefined, "Repository assignees");
        sendJson(response, 200, { items: await options.gateway.listAssignees!() });
        return;
      }

      const subIssueMatch = /^\/api\/issues\/([1-9]\d*)\/sub-issues$/.exec(path);
      if ((request.method === "POST" || request.method === "DELETE") && subIssueMatch !== null) {
        const number = issueNumberFromMatch(subIssueMatch);
        const input = await readJsonBody(request);
        rejectUnknownKeys(input, ["issueNumber"]);
        const related = requiredIssueNumber(input);
        if (related === number) throw new RequestValidationError(400, "An issue cannot be its own sub-issue.");
        ensureCapability(options.gateway.mutateSubIssue !== undefined, "Sub-issues");
        const detail = await runIssueRelationMutation(number, related, () => options.gateway.mutateSubIssue!(number, related, request.method === "POST"));
        sendJson(response, 200, { detail });
        return;
      }

      const blockedMatch = /^\/api\/issues\/([1-9]\d*)\/blocked-by$/.exec(path);
      if ((request.method === "POST" || request.method === "DELETE") && blockedMatch !== null) {
        const number = issueNumberFromMatch(blockedMatch);
        const input = await readJsonBody(request);
        rejectUnknownKeys(input, ["issueNumber"]);
        const related = requiredIssueNumber(input);
        if (related === number) throw new RequestValidationError(400, "An issue cannot block itself.");
        ensureCapability(options.gateway.mutateBlockedBy !== undefined, "Issue dependencies");
        const detail = await runIssueRelationMutation(number, related, () => options.gateway.mutateBlockedBy!(number, related, request.method === "POST"));
        sendJson(response, 200, { detail });
        return;
      }

      if (path === "/api/milestones" && request.method === "GET") {
        await Promise.all([mutations.waitAll("milestone:"), mutations.waitAll("issue:"), mutations.waitAll("pr:")]);
        const rawState = requestUrl.searchParams.get("state") ?? "open";
        if (rawState !== "open" && rawState !== "closed" && rawState !== "all") throw new RequestValidationError(400, "Milestone state must be open, closed, or all.");
        ensureCapability(options.gateway.listMilestones !== undefined, "Milestones");
        sendJson(response, 200, await options.gateway.listMilestones!(rawState));
        return;
      }

      if (path === "/api/milestones" && request.method === "POST") {
        const input = await readJsonBody(request);
        rejectUnknownKeys(input, ["title", "description", "dueOn"]);
        const title = requiredText(input, "title", "Milestone title");
        const description = optionalText(input, "description", "Milestone description");
        const dueOn = optionalDate(input, "dueOn");
        ensureCapability(options.gateway.createMilestone !== undefined, "Milestone creation");
        const creation: { title: string; description?: string; dueOn?: string | null } = { title };
        if (description !== undefined) creation.description = description;
        if (dueOn !== undefined) creation.dueOn = dueOn;
        const milestone = await options.gateway.createMilestone!(creation);
        sendJson(response, 201, { milestone });
        return;
      }

      const milestoneMatch = /^\/api\/milestones\/([1-9]\d*)$/.exec(path);
      if (request.method === "PATCH" && milestoneMatch !== null) {
        const number = issueNumberFromMatch(milestoneMatch);
        const input = await readJsonBody(request);
        rejectUnknownKeys(input, ["title", "description", "dueOn", "state"]);
        const title = optionalTitle(input, "title", "Milestone title");
        if (title !== undefined && title.trim().length === 0) throw new RequestValidationError(400, "Milestone title is required.");
        const description = optionalText(input, "description", "Milestone description");
        const dueOn = optionalDate(input, "dueOn");
        let state: "open" | "closed" | undefined;
        if (input.state !== undefined) state = requiredEnum<"open" | "closed">(input, "state", "Milestone state", ["open", "closed"]);
        const update: { title?: string; description?: string; dueOn?: string | null; state?: "open" | "closed" } = {};
        if (title !== undefined) update.title = title.trim();
        if (description !== undefined) update.description = description;
        if (dueOn !== undefined) update.dueOn = dueOn;
        if (state !== undefined) update.state = state;
        if (Object.keys(update).length === 0) throw new RequestValidationError(400, "At least one milestone field is required.");
        ensureCapability(options.gateway.updateMilestone !== undefined, "Milestone editing");
        const milestone = await mutations.run(`milestone:${number}`, () => options.gateway.updateMilestone!(number, update));
        sendJson(response, 200, { milestone });
        return;
      }

      const milestoneItemsMatch = /^\/api\/milestones\/([1-9]\d*)\/items$/.exec(path);
      if (request.method === "GET" && milestoneItemsMatch !== null) {
        const number = issueNumberFromMatch(milestoneItemsMatch);
        await Promise.all([mutations.wait(`milestone:${number}`), mutations.waitAll("issue:"), mutations.waitAll("pr:")]);
        ensureCapability(options.gateway.getMilestoneItems !== undefined, "Milestone items");
        sendJson(response, 200, await options.gateway.getMilestoneItems!(number));
        return;
      }

      if (request.method === "GET" && path === "/api/branches") {
        ensureCapability(options.gateway.listBranches !== undefined, "Repository branches");
        sendJson(response, 200, { items: await options.gateway.listBranches!() });
        return;
      }

      if (path === "/api/pulls" && request.method === "GET") {
        await mutations.waitAll("pr:");
        const rawState = requestUrl.searchParams.get("state") ?? "open";
        if (rawState !== "open" && rawState !== "closed" && rawState !== "merged" && rawState !== "all") throw new RequestValidationError(400, "Pull request state must be open, closed, merged, or all.");
        ensureCapability(options.gateway.listPullRequests !== undefined, "Pull requests");
        sendJson(response, 200, await options.gateway.listPullRequests!(rawState, parsePage(requestUrl.searchParams.get("page"))));
        return;
      }

      if (path === "/api/pulls" && request.method === "POST") {
        const input = await readJsonBody(request);
        rejectUnknownKeys(input, ["title", "body", "head", "base", "draft"]);
        const creation = { title: requiredText(input, "title", "Pull request title"), body: optionalText(input, "body", "Pull request description") ?? "", head: requiredText(input, "head", "Head branch", 255), base: requiredText(input, "base", "Base branch", 255), draft: requiredBoolean(input, "draft", "Draft state") };
        ensureCapability(options.gateway.createPullRequest !== undefined, "Pull request creation");
        sendJson(response, 201, { pullRequest: await options.gateway.createPullRequest!(creation) });
        return;
      }

      const pullMatch = /^\/api\/pulls\/([1-9]\d*)$/.exec(path);
      if (request.method === "GET" && pullMatch !== null) {
        const number = issueNumberFromMatch(pullMatch);
        await mutations.wait(`pr:${number}`);
        ensureCapability(options.gateway.getPullRequestDetail !== undefined, "Pull request details");
        sendJson(response, 200, { detail: await options.gateway.getPullRequestDetail!(number) });
        return;
      }

      if (request.method === "PATCH" && pullMatch !== null) {
        const number = issueNumberFromMatch(pullMatch);
        const input = await readJsonBody(request);
        rejectUnknownKeys(input, ["title", "body", "state", "milestone"]);
        const title = optionalTitle(input, "title", "Pull request title");
        if (title !== undefined && title.trim().length === 0) throw new RequestValidationError(400, "Pull request title is required.");
        const body = optionalText(input, "body", "Pull request description");
        let state: "open" | "closed" | undefined;
        if (input.state !== undefined) state = requiredEnum<"open" | "closed">(input, "state", "Pull request state", ["open", "closed"]);
        const milestone = optionalNullableNumber(input, "milestone", "Milestone");
        const update: { title?: string; body?: string; state?: "open" | "closed"; milestone?: number | null } = {};
        if (title !== undefined) update.title = title.trim();
        if (body !== undefined) update.body = body;
        if (state !== undefined) update.state = state;
        if (milestone !== undefined) update.milestone = milestone;
        if (Object.keys(update).length === 0) throw new RequestValidationError(400, "At least one pull request field is required.");
        ensureCapability(options.gateway.updatePullRequest !== undefined, "Pull request editing");
        const pullRequest = await mutations.run(`pr:${number}`, () => options.gateway.updatePullRequest!(number, update));
        sendJson(response, 200, { pullRequest });
        return;
      }

      const pullAssigneeMatch = /^\/api\/pulls\/([1-9]\d*)\/assignees$/.exec(path);
      if ((request.method === "POST" || request.method === "DELETE") && pullAssigneeMatch !== null) {
        const number = issueNumberFromMatch(pullAssigneeMatch);
        const input = await readJsonBody(request);
        rejectUnknownKeys(input, ["login"]);
        ensureCapability(options.gateway.mutatePullAssignee !== undefined, "Pull request assignees");
        const pullRequest = await mutations.run(`pr:${number}`, () => options.gateway.mutatePullAssignee!(number, requiredLogin(input), request.method === "POST"));
        sendJson(response, 200, { pullRequest });
        return;
      }

      const draftMatch = /^\/api\/pulls\/([1-9]\d*)\/draft$/.exec(path);
      if (request.method === "POST" && draftMatch !== null) {
        const number = issueNumberFromMatch(draftMatch);
        const input = await readJsonBody(request);
        rejectUnknownKeys(input, ["draft"]);
        ensureCapability(options.gateway.setPullDraft !== undefined, "Draft pull requests");
        const pullRequest = await mutations.run(`pr:${number}`, () => options.gateway.setPullDraft!(number, requiredBoolean(input, "draft", "Draft state")));
        sendJson(response, 200, { pullRequest });
        return;
      }

      const reviewersMatch = /^\/api\/pulls\/([1-9]\d*)\/reviewers$/.exec(path);
      if ((request.method === "POST" || request.method === "DELETE") && reviewersMatch !== null) {
        const number = issueNumberFromMatch(reviewersMatch);
        const input = await readJsonBody(request);
        rejectUnknownKeys(input, ["login"]);
        ensureCapability(options.gateway.mutateReviewer !== undefined, "Pull request reviewers");
        const detail = await mutations.run(`pr:${number}`, () => options.gateway.mutateReviewer!(number, requiredLogin(input), request.method === "POST"));
        sendJson(response, 200, { detail });
        return;
      }

      const reviewsMatch = /^\/api\/pulls\/([1-9]\d*)\/reviews$/.exec(path);
      if (request.method === "POST" && reviewsMatch !== null) {
        const number = issueNumberFromMatch(reviewsMatch);
        const input = await readJsonBody(request);
        rejectUnknownKeys(input, ["event", "body"]);
        const event = requiredEnum(input, "event", "Review event", ["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
        const body = optionalText(input, "body", "Review body") ?? "";
        if ((event === "COMMENT" || event === "REQUEST_CHANGES") && body.trim().length === 0) throw new RequestValidationError(400, "A review body is required for comments and change requests.");
        ensureCapability(options.gateway.createReview !== undefined, "Pull request reviews");
        const detail = await mutations.run(`pr:${number}`, () => options.gateway.createReview!(number, event, body));
        sendJson(response, 201, { detail });
        return;
      }

      const mergeMatch = /^\/api\/pulls\/([1-9]\d*)\/merge$/.exec(path);
      if (request.method === "POST" && mergeMatch !== null) {
        const number = issueNumberFromMatch(mergeMatch);
        const input = await readJsonBody(request);
        rejectUnknownKeys(input, ["method", "expectedHeadSha"]);
        const method = requiredEnum(input, "method", "Merge method", ["merge", "squash", "rebase"]);
        const expectedHeadSha = requiredText(input, "expectedHeadSha", "Expected head SHA", 64);
        if (!/^[0-9a-f]{40}$/i.test(expectedHeadSha)) throw new RequestValidationError(400, "Expected head SHA must be a 40-character hexadecimal commit SHA.");
        ensureCapability(options.gateway.mergePullRequest !== undefined, "Pull request merge");
        const pullRequest = await mutations.run(`pr:${number}`, () => options.gateway.mergePullRequest!(number, method, expectedHeadSha));
        sendJson(response, 200, { pullRequest });
        return;
      }

      if (request.method === "GET" && path === "/api/activity") {
        ensureCapability(options.gateway.listActivity !== undefined, "Repository activity");
        const result = await options.gateway.listActivity!(parsePage(requestUrl.searchParams.get("page")));
        const dates = result.items.map(({ createdAt }) => createdAt).filter((value) => value.length > 0).sort();
        sendJson(response, 200, {
          ...result,
          source: "GitHub repository issue events",
          dateFrom: dates[0] ?? null,
          dateTo: dates.at(-1) ?? null,
          coverage: "GitHub retains and exposes repository issue events according to its API limits; this feed may not contain the repository's complete history.",
        });
        return;
      }

      if (request.method === "GET" && path === "/api/overview") {
        await mutations.waitAll();
        ensureCapability(options.gateway.getOverview !== undefined, "Workspace overview");
        sendJson(response, 200, await options.gateway.getOverview!());
        return;
      }

      if (request.method === "GET" && SHELL_ROUTES[path] === true) {
        sendText(response, 200, "text/html; charset=utf-8", assets.html.replace(CSRF_PLACEHOLDER, csrfToken), "no-store");
        return;
      }
      if (request.method === "GET" && path === "/app.js") {
        sendText(response, 200, "text/javascript; charset=utf-8", assets.javascript, "no-cache");
        return;
      }
      if (request.method === "GET" && path === "/styles.css") {
        sendText(response, 200, "text/css; charset=utf-8", assets.css, "no-cache");
        return;
      }
      if (request.method === "GET" && path === "/favicon.ico") {
        applySecurityHeaders(response);
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
        return;
      }
      sendJson(response, 404, { error: { message: "Not found.", code: "not-found", retryable: false, stateVerified: true } });
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof AnalyticsQueryError) {
        sendJson(response, 400, { error: { message: error.message, code: "validation", retryable: false, stateVerified: true } });
        return;
      }
      if (error instanceof Error && error.name === "AbortError") {
        sendJson(response, 499, { error: { message: "Analytics request cancelled.", code: "aborted", retryable: true, stateVerified: true } });
        return;
      }
      if (error instanceof RequestValidationError || error instanceof HttpError) {
        sendJson(response, error.statusCode, { error: errorPayload(error, true) });
        return;
      }
      if (error instanceof AmbiguousMilestoneCreateError) {
        sendJson(response, 502, { error: errorPayload(error), recovery: { kind: "ambiguous-milestone-create", title: error.title, milestonesUrl: error.recoveryUrl } });
        return;
      }
      if (error instanceof GitHubApiError) {
        const status = error.code === "unsupported" ? 501
          : error.code === "rate-limit" || error.statusCode === 429 ? 429
            : error.code === "not-found" || error.statusCode === 404 ? 404
              : error.statusCode === 409 ? 409
                : error.code === "permission" || error.code === "authentication" ? 403
                  : error.code === "aborted" ? 499
                    : 502;
        sendJson(response, status, { error: errorPayload(error) });
        return;
      }
      if (error instanceof UserError) {
        sendJson(response, 502, { error: errorPayload(error) });
        return;
      }
      sendJson(response, 500, { error: { ...errorPayload(error), message: `Unexpected server error: ${errorMessage(error)}` } });
    } finally {
      if (trustedRequest && request.method !== "GET" && request.url?.startsWith("/api/") === true) analytics?.invalidate();
    }
  };
}

export async function startUiServer(options: UiServerOptions): Promise<RunningUiServer> {
  const assetDirectory = options.assetDirectory ?? resolveUiAssetDirectory();
  const assets = await loadUiAssets(assetDirectory);
  const csrfToken = options.csrfToken ?? randomBytes(24).toString("hex");
  let authority = "";
  const handler = createRequestHandler(options, assets, csrfToken, () => authority);
  const server = createServer((request, response) => { void handler(request, response); });
  server.on("clientError", (_error, socket) => { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); });
  const listening = once(server, "listening");
  server.listen(options.port, UI_HOST);
  try { await listening; }
  catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EADDRINUSE") throw new UserError(`Port ${options.port} is already in use.\n\nChoose another port:\ngitasks ui --port ${options.port + 1}`);
    if (code === "EACCES") throw new UserError(`Permission denied while binding to port ${options.port}.`);
    throw new UserError(`Could not start the local UI server.\n\n${errorMessage(error)}`);
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new UserError("Could not determine the local UI address.");
  }
  authority = `${UI_HOST}:${address.port}`;
  return {
    server,
    port: address.port,
    url: `http://${authority}`,
    csrfToken,
    async close(): Promise<void> {
      if (!server.listening) return;
      const closed = once(server, "close");
      server.close();
      await closed;
    },
  };
}
