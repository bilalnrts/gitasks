import type { ApiErrorPayload } from "./models.js";

interface LegacyErrorPayload {
  error?: string | { message?: string; retryable?: boolean; stateVerified?: boolean; code?: string; permission?: string; unsupported?: string };
  code?: string;
  retryable?: boolean;
  stateVerified?: boolean;
  permission?: string;
  unsupported?: string;
  repair?: unknown;
  task?: unknown;
  recovery?: unknown;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly stateVerified: boolean | undefined;
  readonly permission: string | undefined;
  readonly unsupported: string | undefined;
  readonly payload: LegacyErrorPayload;

  constructor(message: string, status = 0, payload: LegacyErrorPayload = {}) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.payload = payload;
    this.code = payload.code ?? (typeof payload.error === "object" ? payload.error.code : undefined) ?? (status === 0 ? "network" : "request_failed");
    this.retryable = payload.retryable ?? (typeof payload.error === "object" ? payload.error.retryable : undefined) ?? (status === 0 || status >= 500 || status === 429);
    this.stateVerified = payload.stateVerified ?? (typeof payload.error === "object" ? payload.error.stateVerified : undefined);
    this.permission = payload.permission ?? (typeof payload.error === "object" ? payload.error.permission : undefined);
    this.unsupported = payload.unsupported ?? (typeof payload.error === "object" ? payload.error.unsupported : undefined);
  }
}

export interface GuardedResult<T> {
  data: T;
  generation: number;
  current: boolean;
}

function errorMessage(payload: LegacyErrorPayload, status: number): string {
  if (typeof payload.error === "string" && payload.error.trim()) return payload.error;
  if (typeof payload.error === "object" && payload.error?.message?.trim()) return payload.error.message;
  if (payload.permission) return payload.permission;
  if (payload.unsupported) return payload.unsupported;
  return `The local Gitasks server returned HTTP ${status}.`;
}

export class ApiClient {
  private readonly csrf: string;
  private readonly generations = new Map<string, number>();
  private readonly controllers = new Map<string, AbortController>();

  constructor() {
    const csrf = document.querySelector<HTMLMetaElement>('meta[name="gitasks-csrf"]')?.content;
    if (!csrf) throw new Error("Missing Gitasks CSRF token.");
    this.csrf = csrf;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") headers.set("X-Gitasks-CSRF", this.csrf);

    let response: Response;
    try {
      response = await fetch(path, { ...init, headers, credentials: "same-origin" });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
      throw new ApiRequestError(cause instanceof Error ? cause.message : "Could not reach the local Gitasks server.");
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new ApiRequestError(`The local Gitasks server returned an unreadable HTTP ${response.status} response.`, response.status);
    }
    if (!response.ok) {
      const payload = (raw && typeof raw === "object" ? raw : {}) as LegacyErrorPayload;
      throw new ApiRequestError(errorMessage(payload, response.status), response.status, payload);
    }
    return raw as T;
  }

  async latest<T>(key: string, path: string, init: RequestInit = {}): Promise<GuardedResult<T>> {
    this.controllers.get(key)?.abort();
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    const outerSignal = init.signal;
    const abortFromOuter = (): void => controller.abort();
    if (outerSignal?.aborted) controller.abort();
    else outerSignal?.addEventListener("abort", abortFromOuter, { once: true });
    try {
      const data = await this.request<T>(path, { ...init, signal: controller.signal });
      return { data, generation, current: this.generations.get(key) === generation && !controller.signal.aborted };
    } finally {
      outerSignal?.removeEventListener("abort", abortFromOuter);
      if (this.controllers.get(key) === controller) this.controllers.delete(key);
    }
  }

  invalidate(key: string): void {
    const activeKeys = [...new Set([...this.generations.keys(), ...this.controllers.keys()])];
    for (const activeKey of activeKeys) {
      if (activeKey !== key && !activeKey.startsWith(`${key}:`)) continue;
      this.generations.set(activeKey, (this.generations.get(activeKey) ?? 0) + 1);
      this.controllers.get(activeKey)?.abort();
      this.controllers.delete(activeKey);
    }
    if (!activeKeys.includes(key)) this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  abortAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }
}

export type PendingListener = (key: string, pending: boolean) => void;

export class MutationCoordinator {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly pending = new Set<string>();
  private readonly listeners = new Set<PendingListener>();

  isPending(key: string): boolean {
    return this.pending.has(key);
  }

  subscribe(listener: PendingListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async run<T>(key: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    if (!this.pending.has(key)) {
      this.pending.add(key);
      for (const listener of this.listeners) listener(key, true);
    }
    const operation = previous.catch(() => undefined).then(mutation);
    this.tails.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.tails.get(key) === operation) {
        this.tails.delete(key);
        this.pending.delete(key);
        for (const listener of this.listeners) listener(key, false);
      }
    }
  }
}

export function apiErrorDescription(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return error instanceof Error ? error.message : "The request failed.";
  const suffixes: string[] = [];
  if (error.permission) suffixes.push(`Permission: ${error.permission}`);
  if (error.unsupported) suffixes.push(`Unsupported: ${error.unsupported}`);
  if (error.stateVerified === false) suffixes.push("GitHub state could not be verified. Refresh before continuing.");
  if (error.status === 429) suffixes.push("GitHub rate limit reached. Try again after the limit resets.");
  return [error.message, ...suffixes].join(" ");
}

export type ImportedApiErrorPayload = ApiErrorPayload;
