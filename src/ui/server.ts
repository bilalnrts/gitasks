import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTaskIssue, transitionTask } from "../tasks/service.js";
import {
  STATUS_DEFINITIONS,
  normalizeStatus,
  type TaskStatus,
} from "../tasks/statuses.js";
import type {
  TaskCreator,
  TaskGateway,
  TaskIssue,
} from "../tasks/types.js";
import { errorMessage, PartialCreateError, UserError } from "../utils/errors.js";
import { presentTask } from "./presenter.js";

export const DEFAULT_UI_PORT = 4317;
export const UI_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;
const CSRF_PLACEHOLDER = "__GITASKS_CSRF_TOKEN__";

export interface BoardGateway extends TaskGateway, TaskCreator {
  listIssues(state: "open" | "all"): Promise<TaskIssue[]>;
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

interface UiAssets {
  html: string;
  javascript: Buffer;
  css: Buffer;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function parseUiPort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new UserError(`Invalid port: ${value}\n\nUse an integer between 1 and 65535.`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new UserError(`Invalid port: ${value}\n\nUse an integer between 1 and 65535.`);
  }
  return port;
}

export function resolveUiAssetDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const packagedDirectory = join(moduleDirectory, "ui");
  if (existsSync(packagedDirectory)) {
    return packagedDirectory;
  }
  return join(moduleDirectory, "..", "..", "dist", "ui");
}

export async function loadUiAssets(directory: string): Promise<UiAssets> {
  try {
    const [html, javascript, css] = await Promise.all([
      readFile(join(directory, "index.html"), "utf8"),
      readFile(join(directory, "app.js")),
      readFile(join(directory, "styles.css")),
    ]);
    if (!html.includes(CSRF_PLACEHOLDER)) {
      throw new Error("index.html is missing its CSRF placeholder");
    }
    return { html, javascript, css };
  } catch (error) {
    throw new UserError(
      `Gitasks UI assets could not be loaded from ${directory}.\n\nRun:\nnpm run build\n\n${errorMessage(error)}`,
    );
  }
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  applySecurityHeaders(response);
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string | Buffer,
  cacheControl: string,
): void {
  applySecurityHeaders(response);
  response.writeHead(statusCode, {
    "Cache-Control": cacheControl,
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function safeTokenMatch(received: string | undefined, expected: string): boolean {
  if (received === undefined) {
    return false;
  }
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return (
    receivedBytes.length === expectedBytes.length &&
    timingSafeEqual(receivedBytes, expectedBytes)
  );
}

function validateRequestSource(
  request: IncomingMessage,
  authority: string,
  csrfToken: string,
): void {
  if (headerValue(request, "host")?.toLowerCase() !== authority) {
    throw new HttpError(403, "Request host is not allowed.");
  }

  const origin = headerValue(request, "origin");
  const expectedOrigin = `http://${authority}`;
  if (origin !== undefined && origin !== expectedOrigin) {
    throw new HttpError(403, "Cross-origin requests are not allowed.");
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    if (origin !== expectedOrigin) {
      throw new HttpError(403, "Mutating requests require the local UI origin.");
    }
    if (!safeTokenMatch(headerValue(request, "x-gitasks-csrf"), csrfToken)) {
      throw new HttpError(403, "Invalid or missing CSRF token.");
    }
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = headerValue(request, "content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json.");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "Request body is too large.");
    }
    chunks.push(buffer);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must contain valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function rejectUnknownKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new HttpError(400, `Unknown field: ${unknown}`);
  }
}

function parseCreateInput(input: Record<string, unknown>): {
  title: string;
  body: string;
  status: string;
} {
  rejectUnknownKeys(input, ["title", "body", "status"]);
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw new HttpError(400, "Task title is required.");
  }
  if (input.title.trim().length > 256) {
    throw new HttpError(400, "Task title must be 256 characters or fewer.");
  }
  if (input.body !== undefined && typeof input.body !== "string") {
    throw new HttpError(400, "Task description must be a string.");
  }
  if (typeof input.body === "string" && Buffer.byteLength(input.body) > MAX_BODY_BYTES) {
    throw new HttpError(400, "Task description is too large.");
  }
  if (input.status !== undefined && typeof input.status !== "string") {
    throw new HttpError(400, "Task status must be a string.");
  }

  const statusInput = typeof input.status === "string" ? input.status : "backlog";
  try {
    normalizeStatus(statusInput);
  } catch (error) {
    throw new HttpError(400, errorMessage(error));
  }

  return {
    title: input.title.trim(),
    body: typeof input.body === "string" ? input.body : "",
    status: statusInput,
  };
}

function parseStatusInput(input: Record<string, unknown>): TaskStatus {
  rejectUnknownKeys(input, ["status"]);
  if (typeof input.status !== "string") {
    throw new HttpError(400, "Task status is required.");
  }
  try {
    return normalizeStatus(input.status);
  } catch (error) {
    throw new HttpError(400, errorMessage(error));
  }
}

function boardPayload(repository: string, issues: TaskIssue[]) {
  return {
    repository,
    scope: "All GitHub Issues (open and closed); pull requests excluded",
    statuses: STATUS_DEFINITIONS.map(({ name, slug, color }) => ({ name, slug, color })),
    tasks: issues.map(presentTask),
  };
}

function createRequestHandler(
  options: Omit<UiServerOptions, "port" | "assetDirectory" | "csrfToken">,
  assets: UiAssets,
  csrfToken: string,
  getAuthority: () => string,
) {
  const transitionTails = new Map<number, Promise<void>>();
  const enqueueTransition = <T>(issueNumber: number, action: () => Promise<T>): Promise<T> => {
    const previous = transitionTails.get(issueNumber) ?? Promise.resolve();
    const result = previous.then(action);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    transitionTails.set(issueNumber, tail);
    return result.finally(() => {
      if (transitionTails.get(issueNumber) === tail) {
        transitionTails.delete(issueNumber);
      }
    });
  };

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      validateRequestSource(request, getAuthority(), csrfToken);
      const requestUrl = new URL(request.url ?? "/", `http://${getAuthority()}`);
      const path = requestUrl.pathname;

      if (request.method === "GET" && path === "/api/board") {
        const issues = await options.gateway.listIssues("all");
        sendJson(response, 200, boardPayload(options.repository, issues));
        return;
      }

      const issueMatch = /^\/api\/issues\/([1-9]\d*)$/.exec(path);
      if (request.method === "GET" && issueMatch?.[1] !== undefined) {
        const issue = await options.gateway.getIssue(Number(issueMatch[1]));
        sendJson(response, 200, { task: presentTask(issue) });
        return;
      }

      if (request.method === "POST" && path === "/api/issues") {
        const input = parseCreateInput(await readJsonBody(request));
        try {
          const issue = await createTaskIssue(options.gateway, input.title, {
            body: input.body,
            status: input.status,
          });
          sendJson(response, 201, { task: presentTask(issue) });
        } catch (error) {
          if (error instanceof PartialCreateError) {
            sendJson(response, 502, {
              error: { message: error.message, retryable: true },
              task: presentTask(error.issue),
              repair: { issueNumber: error.issue.number, status: "DONE" },
            });
          } else {
            sendJson(response, 502, {
              error: { message: errorMessage(error), retryable: true },
            });
          }
        }
        return;
      }

      const transitionMatch = /^\/api\/issues\/([1-9]\d*)\/status$/.exec(path);
      if (request.method === "POST" && transitionMatch?.[1] !== undefined) {
        const issueNumber = Number(transitionMatch[1]);
        const status = parseStatusInput(await readJsonBody(request));
        await enqueueTransition(issueNumber, async () => {
          try {
            const issue = await transitionTask(options.gateway, String(issueNumber), status);
            sendJson(response, 200, { task: presentTask(issue) });
          } catch (operationError) {
            try {
              const current = await options.gateway.getIssue(issueNumber);
              sendJson(response, 502, {
                error: {
                  message: errorMessage(operationError),
                  retryable: true,
                  stateVerified: true,
                },
                task: presentTask(current),
              });
            } catch {
              sendJson(response, 502, {
                error: {
                  message: errorMessage(operationError),
                  retryable: true,
                  stateVerified: false,
                },
              });
            }
          }
        });
        return;
      }

      if (request.method === "GET" && (path === "/" || path === "/index.html")) {
        sendText(
          response,
          200,
          "text/html; charset=utf-8",
          assets.html.replace(CSRF_PLACEHOLDER, csrfToken),
          "no-store",
        );
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

      sendJson(response, 404, { error: { message: "Not found." } });
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.statusCode, { error: { message: error.message } });
        return;
      }
      if (error instanceof UserError) {
        sendJson(response, 502, {
          error: { message: error.message, retryable: true },
        });
        return;
      }
      sendJson(response, 500, {
        error: { message: `Unexpected server error: ${errorMessage(error)}` },
      });
    }
  };
}

export async function startUiServer(options: UiServerOptions): Promise<RunningUiServer> {
  const assetDirectory = options.assetDirectory ?? resolveUiAssetDirectory();
  const assets = await loadUiAssets(assetDirectory);
  const csrfToken = options.csrfToken ?? randomBytes(24).toString("hex");
  let authority = "";
  const handler = createRequestHandler(options, assets, csrfToken, () => authority);
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  const listening = once(server, "listening");
  server.listen(options.port, UI_HOST);
  try {
    await listening;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      throw new UserError(
        `Port ${options.port} is already in use.\n\nChoose another port:\ngitasks ui --port ${options.port + 1}`,
      );
    }
    if (code === "EACCES") {
      throw new UserError(`Permission denied while binding to port ${options.port}.`);
    }
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
      if (!server.listening) {
        return;
      }
      const closed = once(server, "close");
      server.close();
      await closed;
    },
  };
}
