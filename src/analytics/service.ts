import { UserError } from "../utils/errors.js";
import { buildAnalyticsBootstrap, buildAnalyticsSection } from "./compute.js";
import { parseAnalyticsQuery } from "./time.js";
import {
  ANALYTICS_SECTIONS,
  type AnalyticsBootstrapPayload,
  type AnalyticsGateway,
  type AnalyticsQuery,
  type AnalyticsSection,
  type AnalyticsSectionPayload,
} from "./types.js";

const QUERY_KEYS: Readonly<Record<string, true>> = {
  section: true,
  range: true,
  from: true,
  to: true,
  timezone: true,
  group: true,
  milestone: true,
  label: true,
  person: true,
  role: true,
  bots: true,
  compare: true,
  staleDays: true,
  reviewWaitDays: true,
};
const SINGLE_VALUE_KEYS = Object.keys(QUERY_KEYS).filter((key) => key !== "label");

export class AnalyticsQueryError extends UserError {
  constructor(message: string) {
    super(message);
    this.name = "AnalyticsQueryError";
  }
}

interface CacheEntry<T> {
  value?: T | undefined;
  promise?: Promise<T> | undefined;
  expiresAt: number;
  lastUsed: number;
  waiters: number;
  controller?: AbortController | undefined;
}

export interface AnalyticsServiceOptions {
  repository: string;
  gateway: AnalyticsGateway;
  authenticatedUser?: () => Promise<string>;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => Date;
}

export class AnalyticsService {
  private readonly cache = new Map<string, CacheEntry<AnalyticsBootstrapPayload | AnalyticsSectionPayload>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => Date;

  constructor(private readonly options: AnalyticsServiceOptions) {
    this.ttlMs = Math.max(1, Math.min(options.ttlMs ?? 30_000, 5 * 60_000));
    this.maxEntries = Math.max(1, Math.min(options.maxEntries ?? 32, 128));
    this.now = options.now ?? (() => new Date());
  }

  async bootstrap(params: URLSearchParams, signal?: AbortSignal, refresh = false): Promise<AnalyticsBootstrapPayload> {
    this.validateParameters(params, false);
    const query = this.parse(params, "summary");
    return this.cached("current", query, signal, refresh, async (loadSignal) => {
      const dataset = await this.options.gateway.loadAnalyticsDataset("summary", loadSignal, query);
      return buildAnalyticsBootstrap(dataset, query, this.now());
    }) as Promise<AnalyticsBootstrapPayload>;
  }

  async section(params: URLSearchParams, signal?: AbortSignal, refresh = false): Promise<AnalyticsSectionPayload> {
    this.validateParameters(params, true);
    const values = params.getAll("section");
    const rawSection = values[0];
    if (values.length !== 1 || rawSection === undefined || !ANALYTICS_SECTIONS.includes(rawSection as AnalyticsSection)) {
      throw new AnalyticsQueryError("Analytics section must be one of summary, issues, pull-requests, contributors, milestones, or repository.");
    }
    const section = rawSection as AnalyticsSection;
    const query = this.parse(params, section);
    return this.cached(section, query, signal, refresh, async (loadSignal) => {
      const dataset = await this.options.gateway.loadAnalyticsDataset(section, loadSignal, query);
      return buildAnalyticsSection(dataset, query, this.now());
    }) as Promise<AnalyticsSectionPayload>;
  }

  invalidate(scope?: "current" | AnalyticsSection): void {
    for (const [key, entry] of this.cache) {
      if (scope !== undefined && !key.includes(`\"scope\":\"${scope}\"`)) continue;
      entry.controller?.abort();
      this.cache.delete(key);
    }
  }

  private validateParameters(params: URLSearchParams, sectionRequired: boolean): void {
    const entries = [...params.entries()];
    if (entries.length > 32) throw new AnalyticsQueryError("Too many analytics query parameters.");
    for (const [key, value] of entries) {
      if (QUERY_KEYS[key] !== true || (!sectionRequired && key === "section")) {
        throw new AnalyticsQueryError(`Unknown analytics query parameter: ${key}`);
      }
      if (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new AnalyticsQueryError(`Invalid analytics query parameter: ${key}`);
      }
    }
    for (const key of SINGLE_VALUE_KEYS) {
      if (params.getAll(key).length > 1) throw new AnalyticsQueryError(`Analytics query parameter may only be provided once: ${key}`);
    }
    if (params.getAll("label").length > 20) throw new AnalyticsQueryError("Analytics label filter supports at most 20 values.");
  }

  private parse(params: URLSearchParams, section: AnalyticsSection): AnalyticsQuery {
    try {
      return parseAnalyticsQuery(params, section, this.now());
    } catch (error) {
      throw new AnalyticsQueryError(error instanceof Error ? error.message : String(error));
    }
  }


  private async cached<T extends AnalyticsBootstrapPayload | AnalyticsSectionPayload>(
    scope: "current" | AnalyticsSection,
    query: AnalyticsQuery,
    signal: AbortSignal | undefined,
    refresh: boolean,
    load: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const requestAborted = () => signal?.aborted === true;
    if (requestAborted()) throw new DOMException("The analytics request was cancelled.", "AbortError");
    const userValue = await (this.options.authenticatedUser?.() ?? Promise.resolve("unknown-user"));
    if (requestAborted()) throw new DOMException("The analytics request was cancelled.", "AbortError");
    const user = userValue.trim().toLowerCase() || "unknown-user";
    const key = JSON.stringify({ repository: this.options.repository.toLowerCase(), user, scope, query });
    const timestamp = this.now().getTime();
    this.prune(timestamp);
    const existing = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!refresh && existing?.value !== undefined && existing.expiresAt > timestamp) {
      existing.lastUsed = timestamp;
      return existing.value;
    }
    if (!refresh && existing?.promise !== undefined) {
      existing.lastUsed = timestamp;
      return this.waitFor(key, existing, signal);
    }
    if (existing !== undefined) this.cache.delete(key);
    this.makeRoom();
    const controller = new AbortController();
    const entry: CacheEntry<T> = { expiresAt: 0, lastUsed: timestamp, waiters: 0, controller };
    const promise = load(controller.signal).then((value) => {
      entry.value = value;
      entry.promise = undefined;
      entry.controller = undefined;
      const completedAt = this.now().getTime();
      entry.expiresAt = completedAt + this.ttlMs;
      entry.lastUsed = completedAt;
      if (this.cache.get(key) === entry) this.makeRoom(0);
      return value;
    }).catch((error) => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
      throw error;
    });
    entry.promise = promise;
    this.cache.set(key, entry as CacheEntry<AnalyticsBootstrapPayload | AnalyticsSectionPayload>);
    return this.waitFor(key, entry, signal);
  }

  private waitFor<T>(key: string, entry: CacheEntry<T>, signal?: AbortSignal): Promise<T> {
    const promise = entry.promise;
    if (promise === undefined) return Promise.resolve(entry.value!);
    entry.waiters += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      entry.waiters -= 1;
      if (entry.waiters === 0 && entry.promise !== undefined) {
        entry.controller?.abort();
        if (this.cache.get(key) === entry) this.cache.delete(key);
      }
    };
    if (signal === undefined) return promise.finally(release);
    if (signal.aborted) {
      release();
      return Promise.reject(new DOMException("The analytics request was cancelled.", "AbortError"));
    }
    return new Promise<T>((resolve, reject) => {
      const aborted = (): void => {
        release();
        reject(new DOMException("The analytics request was cancelled.", "AbortError"));
      };
      signal.addEventListener("abort", aborted, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", aborted);
          release();
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", aborted);
          release();
          reject(error);
        },
      );
    });
  }

  private prune(timestamp: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.promise === undefined && entry.expiresAt <= timestamp) this.cache.delete(key);
    }
  }

  private makeRoom(reservedEntries = 1): void {
    while (this.cache.size + reservedEntries > this.maxEntries) {
      let oldest: [string, CacheEntry<AnalyticsBootstrapPayload | AnalyticsSectionPayload>] | undefined;
      for (const candidate of this.cache) {
        if (candidate[1].promise !== undefined) continue;
        if (oldest === undefined || candidate[1].lastUsed < oldest[1].lastUsed) oldest = candidate;
      }
      if (oldest === undefined) return;
      this.cache.delete(oldest[0]);
    }
  }
}
