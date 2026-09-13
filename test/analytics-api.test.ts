import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { AnalyticsDataset, AnalyticsQuery, AnalyticsSection } from "../src/analytics/types.js";
import { AnalyticsService } from "../src/analytics/service.js";
import { GitHubApi, GitHubApiError } from "../src/github/api.js";
import { GitHubClient } from "../src/github/client.js";
import { startUiServer, type BoardGateway, type RunningUiServer } from "../src/ui/server.js";
import type { WorkspaceContext } from "../src/workspace/types.js";
import { runCommand, type CommandRunner } from "../src/utils/exec.js";
import type { CreateIssueInput, IssueTransition, TaskIssue } from "../src/tasks/types.js";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason?: unknown): void } {
  const constructor = Promise as PromiseConstructor & { withResolvers<U>(): { promise: Promise<U>; resolve(value: U): void; reject(reason?: unknown): void } };
  return constructor.withResolvers<T>();
}

const ISSUE: TaskIssue = { number: 1, title: "[TODO] Analytics", body: "", state: "OPEN", labels: ["status:todo"], assignees: [], url: "https://github.com/acme/example/issues/1" };

function dataset(): AnalyticsDataset {
  const fetchedAt = "2026-09-12T12:00:00.000Z";
  return {
    repository: { name: "example", description: null, visibility: "public", defaultBranch: "main", license: "MIT", url: "https://github.com/acme/example", languages: [], releases: [], tags: [], commitWeeks: [] },
    issues: [], pullRequests: [], reviews: [], events: [], milestones: [], fetchedAt,
    coverage: ["complete", "partial", "pending", "error"].map((state, index) => ({
      id: `source-${index}`, label: `Source ${index}`, state: state as "complete" | "partial" | "pending" | "error", loaded: 0,
      knownTotal: null, from: null, to: null, fetchedAt, excluded: 0, reason: state === "complete" ? null : `${state} source`, limitations: [],
    })),
  };
}

function analyticsPull(number: number, state: "open" | "closed" = "open", requestedTeams?: unknown[]) {
  return {
    id: 1000 + number,
    node_id: `PR_${number}`,
    number,
    title: `Pull ${number}`,
    state,
    draft: false,
    merged_at: state === "closed" ? "2026-09-10T00:00:00.000Z" : null,
    closed_at: state === "closed" ? "2026-09-10T00:00:00.000Z" : null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-10T00:00:00.000Z",
    user: null,
    assignees: [],
    requested_reviewers: [],
    ...(requestedTeams === undefined ? {} : { requested_teams: requestedTeams }),
    milestone: null,
    labels: [],
    head: { sha: String(number).padStart(40, "0") },
    changed_files: 1,
    additions: 2,
    deletions: 1,
    html_url: `https://github.com/acme/example/pull/${number}`,
  };
}

function analyticsIssue(number: number) {
  return {
    id: 2000 + number,
    node_id: `I_${number}`,
    number,
    title: `Issue ${number}`,
    body: "",
    state: "open",
    state_reason: null,
    labels: [],
    assignees: [],
    user: null,
    milestone: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-10T00:00:00.000Z",
    closed_at: null,
    html_url: `https://github.com/acme/example/issues/${number}`,
  };
}

function repositoryResponse() {
  return {
    name: "example",
    description: null,
    visibility: "public",
    private: false,
    default_branch: "main",
    license: null,
    html_url: "https://github.com/acme/example",
  };
}

function includedResponse(value: unknown): string {
  return `HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(value)}`;
}

class FakeGateway implements BoardGateway {
  loads: Array<"current" | AnalyticsSection> = [];
  queries: AnalyticsQuery[] = [];
  creates = 0;
  response = dataset();
  currentUser = "octocat";
  analyticsError: Error | null = null;
  waitForAbort = false;
  observedAbort = false;
  waitForUpdate = false;
  resolveUpdate: (() => void) | undefined;
  readonly events = new EventEmitter();

  async listIssues(): Promise<TaskIssue[]> { return [ISSUE]; }
  async getIssue(): Promise<TaskIssue> { return ISSUE; }
  async createIssue(input: CreateIssueInput): Promise<TaskIssue> { this.creates += 1; return { ...ISSUE, title: input.title, body: input.body }; }
  async updateIssue(): Promise<TaskIssue> {
    this.events.emit("mutation-started");
    if (this.waitForUpdate) {
      const gate = deferred<void>();
      this.resolveUpdate = () => gate.resolve(undefined);
      await gate.promise;
    }
    return ISSUE;
  }
  async transitionIssue(_number: number, transition: IssueTransition): Promise<TaskIssue> { return { ...ISSUE, title: transition.title }; }
  async getContext(): Promise<WorkspaceContext> {
    return {
      repository: "acme/example",
      repositoryUrl: "https://github.com/acme/example",
      currentUser: { login: this.currentUser, avatarUrl: "", url: `https://github.com/${this.currentUser}` },
      capabilities: { issues: true, pullRequests: true, mergeMethods: ["merge"], permissions: { push: true, triage: true, maintain: true, admin: false } },
    };
  }
  async loadAnalyticsDataset(scope: "current" | AnalyticsSection = "current", signal?: AbortSignal, query?: AnalyticsQuery): Promise<AnalyticsDataset> {
    this.loads.push(scope);
    if (query !== undefined) this.queries.push(query);
    this.events.emit("started");
    if (this.analyticsError !== null) throw this.analyticsError;
    if (!this.waitForAbort) return this.response;
    if (signal?.aborted !== true) await once(signal!, "abort");
    this.observedAbort = true;
    this.events.emit("aborted");
    throw new DOMException("cancelled", "AbortError");
  }
}

async function start(gateway: FakeGateway): Promise<{ running: RunningUiServer; assets: string }> {
  const assets = await mkdtemp(join(tmpdir(), "gitasks-analytics-"));
  await Promise.all([
    writeFile(join(assets, "index.html"), "__GITASKS_CSRF_TOKEN__", "utf8"),
    writeFile(join(assets, "app.js"), "", "utf8"),
    writeFile(join(assets, "styles.css"), "", "utf8"),
  ]);
  const running = await startUiServer({ repository: "acme/example", gateway, port: 0, assetDirectory: assets, csrfToken: "analytics-token" });
  return { running, assets };
}

async function stop(running: RunningUiServer, assets: string): Promise<void> {
  await running.close();
  await rm(assets, { recursive: true, force: true });
}

describe("GitHub analytics transport", () => {
  test("paginates with cancellation and stable-ID dedupe", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (_file, args, options) => {
      const path = args.at(-1) ?? "";
      calls.push(path);
      assert.ok(options?.signal);
      if (path.endsWith("page=1")) return { stdout: JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }))), stderr: "" };
      return { stdout: JSON.stringify([{ id: 100 }, { id: 101 }]), stderr: "" };
    };
    const items = await new GitHubApi("acme/example", runner).allPages("repos/acme/example/issues?state=all", "issues", { signal: new AbortController().signal });
    assert.equal(items.length, 101);
    assert.equal(calls.length, 2);
  });

  test("preserves pending statistics responses", async () => {
    const runner: CommandRunner = async () => ({ stdout: "HTTP/2.0 202 Accepted\r\ncontent-type: application/json\r\n\r\n", stderr: "" });
    const result = await new GitHubApi("acme/example", runner).restJsonResponse("repos/acme/example/stats/commit_activity", "statistics");
    assert.deepEqual({ status: result.status, value: result.value }, { status: 202, value: null });
  });

  test("returns a real execFile cancellation as aborted before repository sources fan out", async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    let laterSources = 0;
    const runner: CommandRunner = async (_file, args, options) => {
      const path = args.at(-1) ?? "";
      if (path === "repos/acme/example") {
        started.resolve(undefined);
        return runCommand(process.execPath, ["-e", "process.stdin.resume()"], options);
      }
      laterSources += 1;
      return { stdout: "[]", stderr: "" };
    };
    const loading = new GitHubClient("acme/example", runner).loadAnalyticsDataset("repository", controller.signal);
    await started.promise;
    controller.abort();
    await assert.rejects(loading, (error) => error instanceof GitHubApiError && error.code === "aborted");
    assert.equal(laterSources, 0);
  });

  test("loads current bootstrap from open endpoints with concurrent top-level requests", async () => {
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const runner: CommandRunner = async (_file, args) => {
      const path = args.at(-1) ?? "";
      calls.push(path);
      const kind = path === "repos/acme/example" ? "repository"
        : path.includes("/issues?state=open") ? "issues"
          : path.includes("/pulls?state=open") ? "pulls"
            : path.includes("/milestones?state=all") ? "milestones" : "";
      assert.notEqual(kind, "");
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      const value = kind === "repository" ? repositoryResponse() : [];
      return { stdout: JSON.stringify(value), stderr: "" };
    };
    const result = await new GitHubClient("acme/example", runner).loadAnalyticsDataset("current");
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.pullRequests, []);
    assert.ok(calls.some((path) => path.includes("/issues?state=open&")));
    assert.ok(calls.some((path) => path.includes("/pulls?state=open&")));
    assert.ok(calls.every((path) => !path.includes("state=all") || path.includes("/milestones?")));
    assert.equal(maxActive, 4);
  });

  test("hydrates team requests and historical timelines while preserving partial evidence", async () => {
    const pulls = [
      analyticsPull(1),
      analyticsPull(2, "closed", [{ slug: "platform", name: "Platform" }]),
      analyticsPull(3, "closed", []),
    ];
    const timelineCalls: number[] = [];
    const runner: CommandRunner = async (_file, args) => {
      const path = args.at(-1) ?? "";
      if (path === "repos/acme/example") return { stdout: JSON.stringify(repositoryResponse()), stderr: "" };
      if (path.includes("/pulls?state=all")) return { stdout: JSON.stringify(pulls), stderr: "" };
      const detail = /^repos\/acme\/example\/pulls\/(\d+)$/.exec(path);
      if (detail?.[1] !== undefined) return { stdout: JSON.stringify(pulls[Number(detail[1]) - 1]), stderr: "" };
      if (/\/pulls\/\d+\/reviews\?/.test(path)) return { stdout: "[]", stderr: "" };
      if (path.includes("/issues/events?")) return { stdout: "[]", stderr: "" };
      const timeline = /\/issues\/(\d+)\/timeline\?/.exec(path);
      if (timeline?.[1] !== undefined) {
        const number = Number(timeline[1]);
        timelineCalls.push(number);
        if (number === 3) throw new Error("HTTP 500 timeline failed");
        return {
          stdout: JSON.stringify(number === 2
            ? [{ id: 9002, event: "renamed", created_at: "2026-09-05T00:00:00.000Z", rename: { from: "Old title", to: "New title" } }]
            : []),
          stderr: "",
        };
      }
      if (path.endsWith("/status")) return { stdout: JSON.stringify({ state: "success", total_count: 0, statuses: [] }), stderr: "" };
      if (path.includes("/check-runs?")) return { stdout: JSON.stringify({ total_count: 0, check_runs: [] }), stderr: "" };
      throw new Error(`Unexpected path: ${path}`);
    };
    const result = await new GitHubClient("acme/example", runner).loadAnalyticsDataset("pull-requests");
    assert.equal(result.pullRequests.find(({ number }) => number === 1)?.checksState, "unknown");
    assert.deepEqual(result.pullRequests.find(({ number }) => number === 2)?.requestedTeams, ["platform"]);
    assert.deepEqual(timelineCalls.sort((left, right) => left - right), [1, 2, 3]);
    assert.deepEqual(result.events.find(({ type }) => type === "renamed")?.rename, { from: "Old title", to: "New title" });
    const requestCoverage = result.coverage.find(({ id }) => id === "review-requests");
    assert.equal(requestCoverage?.state, "partial");
    assert.equal(requestCoverage?.excluded, 1);
    const timelineCoverage = result.coverage.find(({ id }) => id === "timelines");
    assert.equal(timelineCoverage?.state, "partial");
    assert.equal(timelineCoverage?.excluded, 1);
    assert.equal(result.coverage.find(({ id }) => id === "issue-events")?.state, "partial");
  });

  test("reports partial dependency hydration and unmatched relations", async () => {
    const runner: CommandRunner = async (_file, args) => {
      const path = args.at(-1) ?? "";
      if (path === "repos/acme/example") return { stdout: JSON.stringify(repositoryResponse()), stderr: "" };
      if (path.includes("/issues?state=all")) return { stdout: JSON.stringify([analyticsIssue(1), analyticsIssue(2)]), stderr: "" };
      if (path.includes("/issues/events?")) return { stdout: "[]", stderr: "" };
      if (path.includes("/issues/2/dependencies/blocked_by?")) throw new Error("HTTP 500 dependencies failed");
      if (path.includes("/issues/1/dependencies/blocked_by?")) return { stdout: JSON.stringify([{ number: 99 }]), stderr: "" };
      if (path.includes("/dependencies/")) return { stdout: "[]", stderr: "" };
      throw new Error(`Unexpected path: ${path}`);
    };
    const result = await new GitHubClient("acme/example", runner).loadAnalyticsDataset("issues");
    const source = result.coverage.find(({ id }) => id === "dependencies");
    assert.equal(source?.state, "partial");
    assert.ok((source?.excluded ?? 0) >= 2);
  });

  test("caps per-record analytics fan-out and reports excluded pull requests", async () => {
    const pulls = Array.from({ length: 105 }, (_, index) => analyticsPull(index + 1, "closed", []));
    let detailCalls = 0;
    let reviewCalls = 0;
    let timelineCalls = 0;
    const runner: CommandRunner = async (_file, args) => {
      const path = args.at(-1) ?? "";
      if (path === "repos/acme/example") return { stdout: JSON.stringify(repositoryResponse()), stderr: "" };
      if (path.includes("/pulls?state=all")) return { stdout: JSON.stringify(/[?&]page=1(?:&|$)/.test(path) ? pulls.slice(0, 100) : pulls.slice(100)), stderr: "" };
      const detail = /^repos\/acme\/example\/pulls\/(\d+)$/.exec(path);
      if (detail?.[1] !== undefined) {
        detailCalls += 1;
        return { stdout: JSON.stringify(pulls[Number(detail[1]) - 1]), stderr: "" };
      }
      if (/\/pulls\/\d+\/reviews\?/.test(path)) {
        reviewCalls += 1;
        return { stdout: "[]", stderr: "" };
      }
      if (path.includes("/issues/events?")) return { stdout: "[]", stderr: "" };
      if (/\/issues\/\d+\/timeline\?/.test(path)) {
        timelineCalls += 1;
        return { stdout: "[]", stderr: "" };
      }
      throw new Error(`Unexpected path: ${path}`);
    };
    const result = await new GitHubClient("acme/example", runner).loadAnalyticsDataset("pull-requests");
    assert.deepEqual({ detailCalls, reviewCalls, timelineCalls }, { detailCalls: 100, reviewCalls: 100, timelineCalls: 100 });
    for (const id of ["pull-details", "reviews", "timelines"]) {
      const source = result.coverage.find((item) => item.id === id);
      assert.equal(source?.state, "partial");
      assert.equal(source?.excluded, 5);
    }
  });

  test("hydrates the sole oldest pull request matching known query fields before newer records", async () => {
    const pulls = Array.from({ length: 101 }, (_, index) => ({
      ...analyticsPull(index + 1),
      created_at: index === 0 ? "2020-01-01T00:00:00.000Z" : "2026-09-10T00:00:00.000Z",
      updated_at: index === 0 ? "2020-01-02T00:00:00.000Z" : new Date(Date.UTC(2026, 8, 10) + index * 1000).toISOString(),
      milestone: index === 0 ? { number: 7, title: "Target" } : null,
      labels: index === 0 ? [{ name: "priority" }] : [],
      requested_reviewers: index === 0 ? [{ id: 77, login: "target", type: "User" }] : [],
      requested_teams: [],
    }));
    const hydrated = {
      ...pulls[0]!,
      requested_teams: [{ slug: "platform", name: "Platform" }],
    };
    const detailNumbers: number[] = [];
    const reviewNumbers: number[] = [];
    const timelineNumbers: number[] = [];
    const checkNumbers: number[] = [];
    const runner: CommandRunner = async (_file, args) => {
      const path = args.at(-1) ?? "";
      if (path === "repos/acme/example") return { stdout: JSON.stringify(repositoryResponse()), stderr: "" };
      if (path.includes("/pulls?state=all")) return { stdout: JSON.stringify(/[?&]page=1(?:&|$)/.test(path) ? pulls.slice(0, 100) : pulls.slice(100)), stderr: "" };
      const detail = /^repos\/acme\/example\/pulls\/(\d+)$/.exec(path);
      if (detail?.[1] !== undefined) {
        const number = Number(detail[1]);
        detailNumbers.push(number);
        return { stdout: JSON.stringify(number === 1 ? hydrated : pulls[number - 1]), stderr: "" };
      }
      const review = /\/pulls\/(\d+)\/reviews\?/.exec(path);
      if (review?.[1] !== undefined) {
        reviewNumbers.push(Number(review[1]));
        return { stdout: "[]", stderr: "" };
      }
      if (path.includes("/issues/events?")) return { stdout: "[]", stderr: "" };
      const timeline = /\/issues\/(\d+)\/timeline\?/.exec(path);
      if (timeline?.[1] !== undefined) {
        timelineNumbers.push(Number(timeline[1]));
        return { stdout: "[]", stderr: "" };
      }
      const status = /\/commits\/(\d+)\/status$/.exec(path);
      if (status?.[1] !== undefined) return { stdout: JSON.stringify({ state: "success", total_count: 0, statuses: [] }), stderr: "" };
      const checks = /\/commits\/(\d+)\/check-runs\?/.exec(path);
      if (checks?.[1] !== undefined) {
        checkNumbers.push(Number(checks[1]));
        return { stdout: JSON.stringify({ total_count: 0, check_runs: [] }), stderr: "" };
      }
      throw new Error(`Unexpected path: ${path}`);
    };
    const query: AnalyticsQuery = {
      section: "pull-requests",
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
      timezone: "UTC",
      grouping: "day",
      compare: false,
      milestone: 7,
      labels: ["priority"],
      person: "target",
      role: "reviewer",
      includeBots: false,
      staleDays: 14,
      reviewWaitDays: 3,
    };
    const result = await new GitHubClient("acme/example", runner).loadAnalyticsDataset("pull-requests", undefined, query);
    for (const numbers of [detailNumbers, reviewNumbers, timelineNumbers, checkNumbers]) {
      assert.equal(numbers.length, 100);
      assert.ok(numbers.includes(1));
    }
    assert.deepEqual(result.pullRequests[0]?.requestedTeams, ["platform"]);
  });

  test("hydrates the sole oldest issue matching known query fields for dependencies", async () => {
    const issues = Array.from({ length: 101 }, (_, index) => ({
      ...analyticsIssue(index + 1),
      state: index === 0 ? "closed" : "open",
      closed_at: index === 0 ? "2020-01-03T00:00:00.000Z" : null,
      created_at: index === 0 ? "2020-01-01T00:00:00.000Z" : "2026-09-10T00:00:00.000Z",
      updated_at: index === 0 ? "2020-01-02T00:00:00.000Z" : new Date(Date.UTC(2026, 8, 10) + index * 1000).toISOString(),
      labels: index === 0 ? [{ name: "priority" }] : [],
      assignees: index === 0 ? [{ id: 78, login: "target", type: "User" }] : [],
    }));
    const dependencyNumbers = new Set<number>();
    const runner: CommandRunner = async (_file, args) => {
      const path = args.at(-1) ?? "";
      if (path === "repos/acme/example") return { stdout: JSON.stringify(repositoryResponse()), stderr: "" };
      if (path.includes("/issues?state=all")) return { stdout: JSON.stringify(/[?&]page=1(?:&|$)/.test(path) ? issues.slice(0, 100) : issues.slice(100)), stderr: "" };
      if (path.includes("/issues/events?")) return { stdout: "[]", stderr: "" };
      const dependency = /\/issues\/(\d+)\/dependencies\//.exec(path);
      if (dependency?.[1] !== undefined) {
        dependencyNumbers.add(Number(dependency[1]));
        return { stdout: "[]", stderr: "" };
      }
      throw new Error(`Unexpected path: ${path}`);
    };
    const query: AnalyticsQuery = {
      section: "issues",
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
      timezone: "UTC",
      grouping: "day",
      compare: false,
      milestone: null,
      labels: ["priority"],
      person: "target",
      role: "assignee",
      includeBots: false,
      staleDays: 14,
      reviewWaitDays: 3,
    };
    await new GitHubClient("acme/example", runner).loadAnalyticsDataset("issues", undefined, query);
    assert.equal(dependencyNumbers.size, 100);
    assert.ok(dependencyNumbers.has(1));
  });

  test("keeps repository statistic coverage ranges source-specific", async () => {
    const runner: CommandRunner = async (_file, args) => {
      const path = args.at(-1) ?? "";
      if (path === "repos/acme/example") return { stdout: JSON.stringify(repositoryResponse()), stderr: "" };
      if (path.includes("/languages")) return { stdout: "{}", stderr: "" };
      if (path.includes("/tags?") || path.includes("/releases?")) return { stdout: "[]", stderr: "" };
      if (path.endsWith("/stats/commit_activity")) return { stdout: includedResponse([{ week: 0, total: 4 }, { week: 604800, total: 6 }]), stderr: "" };
      if (path.endsWith("/stats/code_frequency")) return { stdout: includedResponse([[1209600, 10, -3], [1814400, 8, -2]]), stderr: "" };
      if (path.endsWith("/stats/contributors")) {
        return { stdout: includedResponse([{ author: { id: 7, login: "dev" }, weeks: [{ w: 2419200, c: 2, a: 5, d: 1 }, { w: 3024000, c: 3, a: 7, d: 2 }] }]), stderr: "" };
      }
      throw new Error(`Unexpected path: ${path}`);
    };
    const result = await new GitHubClient("acme/example", runner).loadAnalyticsDataset("repository");
    assert.deepEqual(result.repository.commitWeeks.map(({ source }) => source).sort(), ["aggregate", "aggregate", "aggregate", "aggregate", "contributor", "contributor"]);
    const range = (id: string) => {
      const source = result.coverage.find((item) => item.id === id);
      return [source?.from, source?.to];
    };
    assert.deepEqual(range("commit-activity"), ["1970-01-01T00:00:00.000Z", "1970-01-08T00:00:00.000Z"]);
    assert.deepEqual(range("code-frequency"), ["1970-01-15T00:00:00.000Z", "1970-01-22T00:00:00.000Z"]);
    assert.deepEqual(range("contributors"), ["1970-01-29T00:00:00.000Z", "1970-02-05T00:00:00.000Z"]);
  });
  test("loads only retained summary sources with all-state history and raw status evidence", async () => {
    const calls: string[] = [];
    const closed = { ...analyticsIssue(1), state: "closed", closed_at: "2026-09-10T00:00:00.000Z", labels: [{ name: "bug" }, { name: "status:todo" }, { name: "status:blocked" }] };
    const runner: CommandRunner = async (_file, args) => {
      const path = args.at(-1) ?? "";
      calls.push(path);
      if (path === "repos/acme/example") return { stdout: JSON.stringify(repositoryResponse()), stderr: "" };
      if (path.includes("/issues?state=all")) return { stdout: JSON.stringify([closed]), stderr: "" };
      if (path.includes("/pulls?state=all") || path.includes("/milestones?state=all")) return { stdout: "[]", stderr: "" };
      if (path.includes("/issues/events?")) return { stdout: JSON.stringify([{ id: 71, event: "closed", created_at: "2026-09-10T00:00:00.000Z", issue: { number: 1 } }]), stderr: "" };
      if (path.includes("/releases?")) return { stdout: JSON.stringify([{ id: 81, tag_name: "v0.5.0", name: "0.5.0", draft: false, prerelease: false, created_at: "2026-09-09T00:00:00.000Z", published_at: "2026-09-09T00:00:00.000Z", html_url: "https://github.com/acme/example/releases/tag/v0.5.0", author: null }]), stderr: "" };
      throw new Error(`Unexpected path: ${path}`);
    };
    const result = await new GitHubClient("acme/example", runner).loadAnalyticsDataset("summary");
    assert.equal(result.issues[0]?.status, "TODO");
    assert.deepEqual(result.issues[0]?.labels, ["bug"]);
    assert.deepEqual(result.issues[0]?.statusLabels, ["status:todo", "status:blocked"]);
    assert.equal(result.events[0]?.type, "closed");
    assert.equal(result.repository.releases[0]?.tagName, "v0.5.0");
    assert.ok(calls.some((path) => path.includes("/issues?state=all")));
    assert.ok(calls.some((path) => path.includes("/issues/events?")));
    assert.ok(calls.some((path) => path.includes("/releases?")));
    assert.ok(calls.every((path) => !/languages|tags|stats\//.test(path)));
  });

  test("keeps issue-event, timeline, and synthesized review coverage ranges separate", async () => {
    const pull = analyticsPull(1, "closed", []);
    const runner: CommandRunner = async (_file, args) => {
      const path = args.at(-1) ?? "";
      if (path === "repos/acme/example") return { stdout: JSON.stringify(repositoryResponse()), stderr: "" };
      if (path.includes("/pulls?state=all")) return { stdout: JSON.stringify([pull]), stderr: "" };
      if (path === "repos/acme/example/pulls/1") return { stdout: JSON.stringify(pull), stderr: "" };
      if (path.includes("/pulls/1/reviews?")) return { stdout: JSON.stringify([{ id: 91, user: null, state: "APPROVED", submitted_at: "2026-03-03T00:00:00.000Z", commit_id: null, html_url: null }]), stderr: "" };
      if (path.includes("/issues/events?")) return { stdout: JSON.stringify([{ id: 92, event: "closed", created_at: "2026-01-01T00:00:00.000Z", issue: { number: 1, pull_request: {} } }]), stderr: "" };
      if (path.includes("/issues/1/timeline?")) return { stdout: JSON.stringify([{ id: 93, event: "renamed", created_at: "2026-02-02T00:00:00.000Z", rename: { from: "Before", to: "After" } }]), stderr: "" };
      throw new Error(`Unexpected path: ${path}`);
    };
    const result = await new GitHubClient("acme/example", runner).loadAnalyticsDataset("pull-requests");
    const range = (id: string) => {
      const source = result.coverage.find((item) => item.id === id);
      return [source?.from, source?.to];
    };
    assert.deepEqual(range("issue-events"), ["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);
    assert.deepEqual(range("timelines"), ["2026-02-02T00:00:00.000Z", "2026-02-02T00:00:00.000Z"]);
    assert.deepEqual(range("reviews"), ["2026-03-03T00:00:00.000Z", "2026-03-03T00:00:00.000Z"]);
  });

  test("treats truncated all-success prefixes as unknown when hidden checks could fail or remain pending", async () => {
    const pulls = [analyticsPull(1), analyticsPull(2)];
    const runner: CommandRunner = async (_file, args) => {
      const path = args.at(-1) ?? "";
      if (path === "repos/acme/example") return { stdout: JSON.stringify(repositoryResponse()), stderr: "" };
      if (path.includes("/pulls?state=all")) return { stdout: JSON.stringify(pulls), stderr: "" };
      const detail = /^repos\/acme\/example\/pulls\/(\d+)$/.exec(path);
      if (detail?.[1] !== undefined) return { stdout: JSON.stringify(pulls[Number(detail[1]) - 1]), stderr: "" };
      if (/\/pulls\/\d+\/reviews\?/.test(path) || path.includes("/issues/events?") || /\/issues\/\d+\/timeline\?/.test(path)) return { stdout: "[]", stderr: "" };
      if (path.endsWith("/status")) {
        return { stdout: JSON.stringify({ state: "success", total_count: 1, statuses: [{ id: 1, state: "success" }] }), stderr: "" };
      }
      if (path.includes("/check-runs?")) {
        const check_runs = Array.from({ length: 100 }, () => ({ status: "completed", conclusion: "success" }));
        const value = path.includes(encodeURIComponent(pulls[0]!.head.sha))
          ? { total_count: 1001, check_runs }
          : { check_runs };
        return { stdout: JSON.stringify(value), stderr: "" };
      }
      throw new Error(`Unexpected path: ${path}`);
    };
    const result = await new GitHubClient("acme/example", runner).loadAnalyticsDataset("pull-requests");
    assert.deepEqual(result.pullRequests.map(({ checksState }) => checksState), ["unknown", "unknown"]);
    const source = result.coverage.find(({ id }) => id === "checks");
    assert.equal(source?.state, "partial");
    assert.equal(source?.excluded, 1);
    assert.match(source?.reason ?? "", /1 check runs were excluded/);
  });

  test("retains observed failure and pending evidence from incomplete check-run pages", async () => {
    const pulls = [analyticsPull(1), analyticsPull(2)];
    const runner: CommandRunner = async (_file, args) => {
      const path = args.at(-1) ?? "";
      if (path === "repos/acme/example") return { stdout: JSON.stringify(repositoryResponse()), stderr: "" };
      if (path.includes("/pulls?state=all")) return { stdout: JSON.stringify(pulls), stderr: "" };
      const detail = /^repos\/acme\/example\/pulls\/(\d+)$/.exec(path);
      if (detail?.[1] !== undefined) return { stdout: JSON.stringify(pulls[Number(detail[1]) - 1]), stderr: "" };
      if (/\/pulls\/\d+\/reviews\?/.test(path) || path.includes("/issues/events?") || /\/issues\/\d+\/timeline\?/.test(path)) return { stdout: "[]", stderr: "" };
      if (path.endsWith("/status")) {
        return { stdout: JSON.stringify({ state: "success", total_count: 1, statuses: [{ id: 1, state: "success" }] }), stderr: "" };
      }
      if (path.includes("/check-runs?")) {
        const isFailure = path.includes(encodeURIComponent(pulls[0]!.head.sha));
        const check_runs = [
          isFailure
            ? { status: "completed", conclusion: "failure" }
            : { status: "in_progress", conclusion: null },
          ...Array.from({ length: 99 }, () => ({ status: "completed", conclusion: "success" })),
        ];
        const value = isFailure ? { total_count: 1001, check_runs } : { check_runs };
        return { stdout: JSON.stringify(value), stderr: "" };
      }
      throw new Error(`Unexpected path: ${path}`);
    };
    const result = await new GitHubClient("acme/example", runner).loadAnalyticsDataset("pull-requests");
    assert.deepEqual(result.pullRequests.map(({ checksState }) => checksState), ["failure", "pending"]);
    const source = result.coverage.find(({ id }) => id === "checks");
    assert.equal(source?.state, "partial");
    assert.equal(source?.excluded, 1);
  });

  test("classifies action-required and startup-failure check conclusions as failures", async () => {
    const pulls = [analyticsPull(1), analyticsPull(2)];
    const runner: CommandRunner = async (_file, args) => {
      const path = args.at(-1) ?? "";
      if (path === "repos/acme/example") return { stdout: JSON.stringify(repositoryResponse()), stderr: "" };
      if (path.includes("/pulls?state=all")) return { stdout: JSON.stringify(pulls), stderr: "" };
      const detail = /^repos\/acme\/example\/pulls\/(\d+)$/.exec(path);
      if (detail?.[1] !== undefined) return { stdout: JSON.stringify(pulls[Number(detail[1]) - 1]), stderr: "" };
      if (/\/pulls\/\d+\/reviews\?/.test(path) || path.includes("/issues/events?") || /\/issues\/\d+\/timeline\?/.test(path)) return { stdout: "[]", stderr: "" };
      if (path.endsWith("/status")) return { stdout: JSON.stringify({ state: "pending", total_count: 0, statuses: [] }), stderr: "" };
      if (path.includes("/check-runs?")) {
        const conclusion = path.includes(encodeURIComponent(pulls[0]!.head.sha)) ? "action_required" : "startup_failure";
        return { stdout: JSON.stringify({ total_count: 1, check_runs: [{ status: "completed", conclusion }] }), stderr: "" };
      }
      throw new Error(`Unexpected path: ${path}`);
    };
    const result = await new GitHubClient("acme/example", runner).loadAnalyticsDataset("pull-requests");
    assert.deepEqual(result.pullRequests.map(({ checksState }) => checksState), ["failure", "failure"]);
  });

});

describe("analytics service cache", () => {
  const params = () => new URLSearchParams("section=issues&range=custom&from=2026-09-01&to=2026-09-12&timezone=UTC");

  test("isolates an aborted waiter from another waiter on the shared load", async () => {
    let loads = 0;
    let loadSignal: AbortSignal | undefined;
    let resolveLoad!: (value: AnalyticsDataset) => void;
    const started = new EventEmitter();
    const service = new AnalyticsService({
      repository: "acme/example",
      now: () => new Date("2026-09-12T12:00:00.000Z"),
      gateway: {
        loadAnalyticsDataset: async (_scope, signal) => {
          loads += 1;
          loadSignal = signal;
          started.emit("started");
          return new Promise<AnalyticsDataset>((resolve) => { resolveLoad = resolve; });
        },
      },
    });
    const firstController = new AbortController();
    const loadStarted = once(started, "started");
    const first = service.section(params(), firstController.signal);
    const second = service.section(params());
    await loadStarted;
    await Promise.resolve();
    firstController.abort();
    await assert.rejects(first, { name: "AbortError" });
    assert.equal(loadSignal?.aborted, false);
    resolveLoad(dataset());
    assert.equal((await second).section, "issues");
    assert.equal(loads, 1);
  });

  test("uses the injected clock for cache expiry", async () => {
    let timestamp = Date.parse("2026-09-12T12:00:00.000Z");
    let loads = 0;
    const service = new AnalyticsService({
      repository: "acme/example",
      ttlMs: 1000,
      now: () => new Date(timestamp),
      gateway: {
        loadAnalyticsDataset: async () => {
          loads += 1;
          return dataset();
        },
      },
    });
    await service.section(params());
    timestamp += 999;
    await service.section(params());
    assert.equal(loads, 1);
    timestamp += 1;
    await service.section(params());
    assert.equal(loads, 2);
  });
  test("allows 33 in-flight entries to finish without capacity eviction", async () => {
    const signals: AbortSignal[] = [];
    const resolves: Array<(value: AnalyticsDataset) => void> = [];
    const startGate = deferred<void>();
    const started = startGate.promise;
    let hold = true;
    const service = new AnalyticsService({
      repository: "acme/example",
      maxEntries: 32,
      now: () => new Date("2026-09-12T12:00:00.000Z"),
      gateway: {
        loadAnalyticsDataset: async (_scope, signal) => {
          signals.push(signal!);
          if (signals.length === 33) startGate.resolve(undefined);
          if (!hold) return dataset();
          const gate = deferred<AnalyticsDataset>();
          resolves.push(gate.resolve);
          return gate.promise;
        },
      },
    });
    const pending = Array.from({ length: 33 }, (_, index) => {
      const query = params();
      query.append("label", `label-${index}`);
      return service.section(query);
    });
    await started;
    assert.equal(signals.some(({ aborted }) => aborted), false);
    hold = false;
    for (const resolve of resolves) resolve(dataset());
    assert.equal((await Promise.all(pending)).length, 33);
    const firstQuery = params();
    firstQuery.append("label", "label-0");
    await service.section(firstQuery);
    assert.equal(signals.length, 34);
  });

  test("builds bootstrap summary from all-state history and forwards its query", async () => {
    const response = dataset();
    response.issues = [{
      id: 2001, nodeId: "I_1", number: 1, title: "Closed", fullTitle: "[DONE] Closed", state: "closed", stateReason: "completed",
      status: "DONE", labels: [], statusLabels: ["status:done"], author: { id: "99", login: "dependabot[bot]", displayName: "dependabot[bot]", avatarUrl: null, url: null, bot: true, deleted: false }, assignees: [], milestone: null,
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z", closedAt: "2026-09-10T00:00:00.000Z",
      url: "https://github.com/acme/example/issues/1", blockedBy: [], blocking: [],
    }];
    response.events = [{
      id: "closed-1", subject: "issue", number: 1, type: "closed", createdAt: "2026-09-10T00:00:00.000Z",
      actor: null, label: null, assignee: null, reviewer: null, milestoneTitle: null, reviewId: null, reviewState: null, rename: null,
    }];
    let receivedScope: "current" | AnalyticsSection | undefined;
    let receivedQuery: AnalyticsQuery | undefined;
    const service = new AnalyticsService({
      repository: "acme/example",
      now: () => new Date("2026-09-12T12:00:00.000Z"),
      gateway: {
        loadAnalyticsDataset: async (scope, _signal, query) => {
          receivedScope = scope;
          receivedQuery = query;
          return response;
        },
      },
    });
    const result = await service.bootstrap(new URLSearchParams("range=custom&from=2026-09-01&to=2026-09-12&timezone=Asia%2FKathmandu&bots=true"));
    assert.equal(receivedScope, "summary");
    assert.equal(receivedQuery?.timezone, "Asia/Kathmandu");
    assert.equal(receivedQuery?.includeBots, true);
    assert.equal(result.current.metrics.find(({ id }) => id === "issues.period.closed_unique")?.value, 1);
    assert.deepEqual(result.options.people.map(({ id }) => id), ["99"]);
    assert.deepEqual(result.options.labels, []);
  });

});

describe("analytics HTTP API", () => {
  test("rejects unknown, duplicate, arbitrary repo/URL/path, and malformed values before loading", async () => {
    const gateway = new FakeGateway();
    const { running, assets } = await start(gateway);
    try {
      for (const query of ["section=nope", "section=issues&section=summary", "section=issues&repo=x/y", "section=issues&url=https://evil.test", "section=issues&path=../x", "section=issues&timezone=invalid", "section=summary&range=custom&from=0100-01-01&to=9999-12-31&timezone=UTC&group=day"]) {
        const response = await fetch(`${running.url}/api/analytics?${query}`);
        assert.equal(response.status, 400);
        const payload = await response.json() as { error: { message: string; code: string; retryable: boolean; stateVerified: boolean } };
        assert.match(payload.error.message, /./);
        assert.deepEqual({ ...payload.error, message: "<message>" }, { message: "<message>", code: "validation", retryable: false, stateVerified: true });
      }
      assert.deepEqual(gateway.loads, []);
    } finally { await stop(running, assets); }
  });

  test("is lightweight/read-only, section-scoped, cached, and returns explicit partial states", async () => {
    const gateway = new FakeGateway();
    const { running, assets } = await start(gateway);
    try {
      assert.equal((await fetch(`${running.url}/api/analytics/bootstrap?timezone=Asia%2FKathmandu&bots=true`)).status, 200);
      const response = await fetch(`${running.url}/api/analytics?section=issues`);
      const payload = await response.json() as { coverage: Array<{ state: string }> };
      assert.equal(response.status, 200);
      assert.equal(gateway.creates, 0);
      assert.deepEqual(gateway.loads, ["summary", "issues"]);
      assert.ok(payload.coverage.some(({ state }) => state === "partial"));
      assert.ok(payload.coverage.some(({ state }) => state === "pending"));
      assert.ok(payload.coverage.some(({ state }) => state === "error"));
      await fetch(`${running.url}/api/analytics?section=issues`);
      assert.deepEqual(gateway.loads, ["summary", "issues"]);
      gateway.currentUser = "hubot";
      await fetch(`${running.url}/api/analytics?section=issues`);
      assert.deepEqual(gateway.loads, ["summary", "issues", "issues"]);
      assert.equal(gateway.queries[0]?.timezone, "Asia/Kathmandu");
      assert.equal(gateway.queries[0]?.includeBots, true);
    } finally { await stop(running, assets); }
  });

  test("consumes refresh=1 and bypasses the analytics cache", async () => {
    const gateway = new FakeGateway();
    const { running, assets } = await start(gateway);
    try {
      assert.equal((await fetch(`${running.url}/api/analytics?section=issues`)).status, 200);
      assert.equal((await fetch(`${running.url}/api/analytics?section=issues`)).status, 200);
      assert.deepEqual(gateway.loads, ["issues"]);
      assert.equal((await fetch(`${running.url}/api/analytics?section=issues&refresh=1`)).status, 200);
      assert.deepEqual(gateway.loads, ["issues", "issues"]);
      assert.equal((await fetch(`${running.url}/api/analytics?section=issues`)).status, 200);
      assert.deepEqual(gateway.loads, ["issues", "issues"]);
      assert.equal((await fetch(`${running.url}/api/analytics?section=issues&refresh=0`)).status, 400);
    } finally { await stop(running, assets); }
  });

  test("invalidates cached reads after mutations", async () => {
    const gateway = new FakeGateway();
    const { running, assets } = await start(gateway);
    try {
      await fetch(`${running.url}/api/analytics?section=summary`);
      const mutation = await fetch(`${running.url}/api/issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: running.url, "X-Gitasks-CSRF": running.csrfToken },
        body: JSON.stringify({ title: "Changed", body: "", status: "todo" }),
      });
      assert.equal(mutation.status, 201);
      await fetch(`${running.url}/api/analytics?section=summary`);
      assert.deepEqual(gateway.loads, ["summary", "summary"]);
    } finally { await stop(running, assets); }
  });

  test("does not start analytics after cancellation while waiting for a mutation", async () => {
    const gateway = new FakeGateway();
    gateway.waitForUpdate = true;
    const { running, assets } = await start(gateway);
    try {
      const mutationStarted = once(gateway.events, "mutation-started");
      const mutation = fetch(`${running.url}/api/issues/1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: running.url, "X-Gitasks-CSRF": running.csrfToken },
        body: JSON.stringify({ title: "Changed" }),
      });
      await mutationStarted;
      const controller = new AbortController();
      const analyticsReceived = once(running.server, "request");
      const analytics = fetch(`${running.url}/api/analytics?section=issues`, { signal: controller.signal });
      const [, serverResponse] = await analyticsReceived;
      const connectionClosed = once(serverResponse, "close");
      controller.abort();
      await assert.rejects(analytics, { name: "AbortError" });
      await connectionClosed;
      gateway.resolveUpdate?.();
      assert.equal((await mutation).status, 200);
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(gateway.loads, []);
    } finally {
      gateway.resolveUpdate?.();
      await stop(running, assets);
    }
  });

  test("maps rate limits and cancels disconnected requests", async () => {
    const gateway = new FakeGateway();
    const { running, assets } = await start(gateway);
    try {
      gateway.analyticsError = new GitHubApiError("API rate limit exceeded.", "rate-limit", true, true, 429);
      assert.equal((await fetch(`${running.url}/api/analytics?section=repository`)).status, 429);
      gateway.analyticsError = null;
      gateway.waitForAbort = true;
      const controller = new AbortController();
      const started = once(gateway.events, "started");
      const pending = fetch(`${running.url}/api/analytics?section=contributors`, { signal: controller.signal });
      await started;
      const aborted = once(gateway.events, "aborted");
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
      await aborted;
      assert.equal(gateway.observedAbort, true);
    } finally { await stop(running, assets); }
  });
});
