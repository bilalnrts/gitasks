import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type {
  AnalyticsBootstrapPayload,
  AnalyticsChart,
  AnalyticsCoverageSource,
  AnalyticsSection,
  AnalyticsSectionPayload,
  AnalyticsTable,
} from "../src/analytics/types.js";
import { ApiClient, ApiRequestError } from "../src/ui/client/api.js";
import {
  ANALYTICS_TAB_LABELS,
  renderAnalyticsChart,
  renderAnalyticsDrilldownFacts,
  renderAnalyticsTable,
  renderCoverage,
  renderWarnings,
  triggerAnalyticsCsv,
} from "../src/ui/client/components/analytics.js";
import { Router, parseRoute } from "../src/ui/client/router.js";
import type { AppServices } from "../src/ui/client/services.js";
import { AnalyticsView, drilldownHref, normalizeAnalyticsQuery } from "../src/ui/client/views/analytics.js";

class FakeNode {
  parentNode: FakeNode | null = null;
  children: FakeNode[] = [];
  private ownText = "";

  get textContent(): string { return this.ownText + this.children.map((child) => child.textContent).join(""); }
  set textContent(value: string) { this.ownText = value; this.children = []; }

  append(...items: Array<FakeNode | string | number>): void {
    for (const item of items) {
      const child = item instanceof FakeNode ? item : new FakeText(String(item));
      child.parentNode = this;
      this.children.push(child);
    }
  }

  replaceChildren(...items: Array<FakeNode | string>): void { this.children = []; this.ownText = ""; this.append(...items); }
  remove(): void { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); }
}

class FakeText extends FakeNode {
  constructor(value: string) { super(); this.textContent = value; }
}

class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  className = "";
  id = "";
  disabled = false;
  hidden = false;
  open = false;
  checked = false;
  selected = false;
  value = "";
  clicked = false;

  constructor(readonly tagName: string) { super(); }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "class") this.className = value;
    if (name === "id") this.id = value;
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = value;
  }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  toggleAttribute(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.attributes.has(name);
    if (enabled) this.attributes.set(name, ""); else this.attributes.delete(name);
    return enabled;
  }
  addEventListener(name: string, listener: (event: Record<string, unknown>) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  click(): void {
    this.clicked = true;
    for (const listener of this.listeners.get("click") ?? []) listener({ currentTarget: this, target: this, preventDefault() {} });
  }
  focus(): void {}
  setSelectionRange(): void {}
  get firstElementChild(): FakeElement | null { return this.children.find((child): child is FakeElement => child instanceof FakeElement) ?? null; }
  get lastElementChild(): FakeElement | null { return [...this.children].reverse().find((child): child is FakeElement => child instanceof FakeElement) ?? null; }
  get childElementCount(): number { return this.children.filter((child) => child instanceof FakeElement).length; }
  querySelectorAll(predicate: string): FakeElement[] { return walk(this).filter((node) => matches(node, predicate)); }
  querySelector(predicate: string): FakeElement | null { return this.querySelectorAll(predicate)[0] ?? null; }
}

class FakeDocument {
  readonly body = new FakeElement("body");
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  createElement(tag: string): FakeElement { return new FakeElement(tag.toLowerCase()); }
  createElementNS(_namespace: string, tag: string): FakeElement { return this.createElement(tag); }
  createTextNode(value: string): FakeText { return new FakeText(value); }
  querySelector(selector: string): FakeElement | { content: string } | null {
    if (selector === 'meta[name="gitasks-csrf"]') return { content: "test-token" };
    return this.body.querySelector(selector);
  }
  addEventListener(name: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  removeEventListener(): void {}
}

function walk(root: FakeNode): FakeElement[] {
  const result: FakeElement[] = [];
  for (const child of root.children) {
    if (child instanceof FakeElement) result.push(child);
    result.push(...walk(child));
  }
  return result;
}

function matches(node: FakeElement, selector: string): boolean {
  if (selector.startsWith("[")) {
    const attribute = selector.slice(1, -1).split("=")[0]!;
    return node.attributes.has(attribute) || attribute.startsWith("data-") && node.dataset[attribute.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] !== undefined;
  }
  const attributeMatch = selector.match(/^([a-z]+)\[([^=]+)=?["']?([^\]"']*)/i);
  if (attributeMatch) return node.tagName === attributeMatch[1]!.toLowerCase() && node.getAttribute(attributeMatch[2]!) === attributeMatch[3];
  return node.tagName === selector.toLowerCase();
}

function installFakeDom(): { document: FakeDocument; restore(): void } {
  const original = { Node: globalThis.Node, HTMLElement: globalThis.HTMLElement, HTMLInputElement: globalThis.HTMLInputElement, KeyboardEvent: globalThis.KeyboardEvent, document: globalThis.document, window: globalThis.window };
  const document = new FakeDocument();
  Object.assign(globalThis, {
    Node: FakeNode,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeElement,
    KeyboardEvent: class {},
    document,
    window: { setTimeout, clearTimeout, location: { href: "http://localhost/overview", origin: "http://localhost", pathname: "/overview", search: "", hash: "" }, addEventListener() {}, removeEventListener() {} },
  });
  return { document, restore: () => Object.assign(globalThis, original) };
}

function payload(section: AnalyticsSection = "summary"): AnalyticsSectionPayload {
  return {
    section,
    period: { from: "2026-08-14T00:00:00.000Z", to: "2026-09-13T00:00:00.000Z", timezone: "UTC", grouping: "day", incomplete: true, previous: null },
    filters: { milestone: null, labels: [], person: null, role: null, includeBots: false, staleDays: 14, reviewWaitDays: 3 },
    computedAt: "2026-09-12T12:00:00.000Z",
    scope: "All returned repository records",
    metrics: [], charts: [], tables: [], coverage: [], warnings: [], repository: null,
  };
}

function bootstrap(): AnalyticsBootstrapPayload {
  return {
    repository: "acme/example",
    computedAt: "2026-09-12T12:00:00.000Z",
    defaults: { section: "summary", from: "2026-08-14T00:00:00.000Z", to: "2026-09-13T00:00:00.000Z", timezone: "UTC", grouping: "day", milestone: null, labels: [], person: null, role: null, includeBots: false, compare: false, staleDays: 14, reviewWaitDays: 3 },
    options: {
      milestones: [{ number: 7, title: "A milestone with a deliberately long title that remains selectable" }],
      labels: ["bug", "extremely-long-label-name-that-must-not-overflow"],
      people: [{ id: "1", login: "octocat", displayName: "Octocat", avatarUrl: null, url: "https://github.com/octocat", bot: false, deleted: false }],
      timezones: ["UTC", "America/New_York", "Asia/Kathmandu"],
    },
    current: payload(),
  };
}

function botAwareBootstrap(request: string): AnalyticsBootstrapPayload {
  const value = bootstrap();
  if (new URL(request, "http://localhost").searchParams.get("bots") !== "true") return value;
  value.defaults.includeBots = true;
  value.current.filters.includeBots = true;
  value.options.people.push({ id: "2", login: "automation-bot", displayName: "Automation", avatarUrl: null, url: "https://github.com/apps/automation", bot: true, deleted: false });
  return value;
}

function analyticsViewHarness(
  requests: string[],
  sectionPayload: (section: AnalyticsSection) => AnalyticsSectionPayload = payload,
  bootstrapPayload: (request: string) => AnalyticsBootstrapPayload = bootstrap,
): { services: AppServices; routerCalls: string[]; updated(): Promise<void> } {
  let generation = 0;
  let pendingUpdates = 0;
  const updateWaiters: Array<() => void> = [];
  const routerCalls: string[] = [];
  const services = {
    api: {
      invalidate() {},
      async latest<T>(_key: string, request: string): Promise<{ data: T; generation: number; current: boolean }> {
        requests.push(request);
        generation += 1;
        const section = new URL(request, "http://localhost").searchParams.get("section") as AnalyticsSection | null;
        const data = request.startsWith("/api/analytics/bootstrap") ? bootstrapPayload(request) : sectionPayload(section ?? "summary");
        return { data: data as unknown as T, generation, current: true };
      },
    },
    router: { updateQuery() { routerCalls.push("updateQuery"); }, navigate(href: string) { routerCalls.push(href); } },
    overlays: {},
    toasts: {},
    mutations: {},
    context: { repository: "acme/example" },
    overlayRoot: globalThis.document.body,
    announce() {
      const resolve = updateWaiters.shift();
      if (resolve) resolve();
      else pendingUpdates += 1;
    },
  } as unknown as AppServices;
  return {
    routerCalls,
    services,
    updated: () => {
      if (pendingUpdates > 0) {
        pendingUpdates -= 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => updateWaiters.push(resolve));
    },
  };
}

function chart(): AnalyticsChart {
  return {
    id: "opened-by-day", title: "Issues opened over time", description: "Returned opening events grouped by calendar day.", kind: "line", unit: "issues", coverage: "partial", zeroBaseline: true,
    warnings: [{ code: "timeline-partial", message: "A deliberately long partial coverage explanation remains readable.", excluded: 2, source: "Timelines" }],
    series: [{ id: "opened", label: "Opened", unit: "issues", points: [
      { key: "2026-09-10", label: "September 10", value: 2, detail: { kind: "issue-event", ids: ["event-1", "event-2"] } },
      { key: "2026-09-11", label: "September 11", value: 0, detail: { kind: "issue-event", ids: [] } },
    ] }],
    tableColumns: [{ key: "day", label: "Day" }, { key: "opened", label: "Opened" }],
    tableRows: [{ day: "September 10", opened: 2, _detailKind: "issue-event", _detailIds: "event-1,event-2" }, { day: "September 11", opened: 0, _detailKind: "issue-event", _detailIds: "" }],
  };
}

function detailTable(rows = 60): AnalyticsTable {
  return {
    id: "issue-events", title: "Issue event details", description: "Every returned event remains a separate row.",
    columns: [{ key: "number", label: "Issue", numeric: true }, { key: "title", label: "Title" }, { key: "event", label: "Event" }],
    rows: Array.from({ length: rows }, (_, index) => ({ number: index + 1, title: `A long returned title ${index} ${"scope ".repeat(20)}`, event: "closed", _detailKind: "issue-event", _detailIds: `event-${index}` })),
    total: rows, scope: "All returned event rows, not the visible page", coverage: "partial",
    warnings: [{ code: "partial", message: "Some event pages were unavailable.", excluded: 3, source: "Issue timelines" }],
  };
}

describe("analytics route and URL contract", () => {
  test("recognizes analytics without changing the five existing routes", () => {
    assert.equal(parseRoute({ pathname: "/analytics", search: "?tab=repository", hash: "" } as Location).name, "analytics");
    assert.deepEqual(["/overview", "/tasks", "/activity", "/pull-requests", "/milestones"].map((pathname) => parseRoute({ pathname, search: "", hash: "" } as Location).name), ["overview", "tasks", "activity", "pull-requests", "milestones"]);
  });

  test("normalizes all six tabs and preserves complete filter state", () => {
    for (const section of Object.keys(ANALYTICS_TAB_LABELS) as AnalyticsSection[]) {
      const query = new URLSearchParams(`tab=${section}&range=custom&from=2026-09-01&to=2026-09-12&timezone=Asia%2FKathmandu&group=week&milestone=7&label=bug&label=triage&person=octocat&role=reviewer&bots=true&compare=true&staleDays=21&reviewWaitDays=5`);
      const normalized = normalizeAnalyticsQuery(query, bootstrap());
      const request = new URL(normalized.request, "http://localhost");
      assert.equal(normalized.value.section, section);
      assert.equal(request.searchParams.get("section"), section);
      assert.deepEqual(request.searchParams.getAll("label"), ["bug", "triage"]);
      assert.equal(request.searchParams.get("person"), "1");
      assert.equal(request.searchParams.get("timezone"), "Asia/Kathmandu");
      assert.equal(normalized.invalid.length, 0);
    }
  });

  test("preserves a valid shared IANA timezone even when bootstrap did not suggest it", () => {
    const value = bootstrap();
    value.options.timezones = ["UTC"];
    const normalized = normalizeAnalyticsQuery(new URLSearchParams("timezone=Asia%2FKathmandu&person=octocat"), value);
    const request = new URL(normalized.request, "http://localhost");
    assert.equal(normalized.value.timezone, "Asia/Kathmandu");
    assert.equal(request.searchParams.get("timezone"), "Asia/Kathmandu");
    assert.equal(request.searchParams.get("person"), "1");
    assert.deepEqual(normalized.invalid, []);
  });

  test("falls back visibly for invalid direct links", () => {
    const normalized = normalizeAnalyticsQuery(new URLSearchParams("tab=unknown&range=custom&from=nope&timezone=Mars%2FBase&staleDays=0"), bootstrap());
    assert.equal(normalized.value.section, "summary");
    assert.equal(normalized.value.timezone, "UTC");
    assert.ok(normalized.invalid.length >= 4);
    assert.doesNotMatch(normalized.request, /from=nope/);
  });

  test("pushes, replaces, and restores analytics query history", () => {
    const dom = installFakeDom();
    const previousHistory = globalThis.history;
    const location = (globalThis.window as unknown as { location: { href: string; origin: string; pathname: string; search: string; hash: string } }).location;
    const entries = ["/analytics?tab=summary"];
    let index = 0;
    const setLocation = (href: string): void => {
      const url = new URL(href, location.href);
      location.href = url.href;
      location.origin = url.origin;
      location.pathname = url.pathname;
      location.search = url.search;
      location.hash = url.hash;
    };
    Object.assign(globalThis, { history: {
      state: { gitasks: true },
      pushState(_state: unknown, _title: string, href: string) { entries.splice(++index); entries.push(href); setLocation(href); },
      replaceState(_state: unknown, _title: string, href: string) { entries[index] = href; setLocation(href); },
      back() { index = Math.max(0, index - 1); setLocation(entries[index]!); },
    } });
    setLocation(entries[0]!);
    try {
      const router = new Router();
      router.navigate("/analytics?tab=issues&range=7");
      router.navigate("/analytics?tab=repository", { replace: true });
      assert.equal(router.current().query.get("tab"), "repository");
      globalThis.history.back();
      assert.equal(router.current().query.get("tab"), "summary");
      router.dispose();
    } finally {
      Object.assign(globalThis, { history: previousHistory });
      dom.restore();
    }
  });
});

describe("analytics request safety", () => {
  test("aborts a superseded section request so a stale response cannot win", async () => {
    const dom = installFakeDom();
    const previousFetch = globalThis.fetch;
    let request = 0;
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      request += 1;
      const current = request;
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        if (current === 2) resolve(new Response(JSON.stringify({ section: "repository" }), { status: 200, headers: { "content-type": "application/json" } }));
      });
    }) as typeof fetch;
    try {
      const api = new ApiClient();
      const first = api.latest("analytics:section", "/api/analytics?section=issues").then(() => "resolved", (error: unknown) => error instanceof DOMException ? error.name : "failed");
      const second = api.latest<{ section: string }>("analytics:section", "/api/analytics?section=repository");
      assert.equal(await first, "AbortError");
      assert.equal((await second).data.section, "repository");
    } finally {
      globalThis.fetch = previousFetch;
      dom.restore();
    }
  });

  test("reuses the matching bootstrap Summary without a duplicate section request", async () => {
    const dom = installFakeDom();
    const requests: string[] = [];
    const route = parseRoute({ pathname: "/analytics", search: "", hash: "" } as Location);
    const harness = analyticsViewHarness(requests);
    const root = dom.document.createElement("main");
    const view = new AnalyticsView(root as unknown as HTMLElement, harness.services, route);
    try {
      await harness.updated();
      assert.deepEqual(requests, ["/api/analytics/bootstrap"]);
      assert.match(root.textContent, /All returned repository records/);
    } finally {
      view.dispose();
      dom.restore();
    }
  });

  test("rebuilds person options when bot inclusion changes without changing normalized URL state", async () => {
    const dom = installFakeDom();
    const requests: string[] = [];
    const route = parseRoute({ pathname: "/analytics", search: "", hash: "" } as Location);
    const harness = analyticsViewHarness(requests, payload, botAwareBootstrap);
    const root = dom.document.createElement("main");
    const view = new AnalyticsView(root as unknown as HTMLElement, harness.services, route);
    try {
      await harness.updated();
      assert.equal(walk(root).some((node) => node.tagName === "option" && node.getAttribute("value") === "2"), false);

      const botsRoute = parseRoute({ pathname: "/analytics", search: "?bots=true", hash: "" } as Location);
      const routeState = botsRoute.query.toString();
      view.update(botsRoute);
      await harness.updated();

      assert.equal(requests.length, 3);
      assert.deepEqual(requests.slice(0, 2), ["/api/analytics/bootstrap", "/api/analytics/bootstrap?bots=true"]);
      const sectionRequest = new URL(requests[2]!, "http://localhost");
      assert.equal(sectionRequest.pathname, "/api/analytics");
      assert.equal(sectionRequest.searchParams.get("section"), "summary");
      assert.equal(sectionRequest.searchParams.get("bots"), "true");
      assert.ok(walk(root).some((node) => node.tagName === "option" && node.getAttribute("value") === "2"));
      assert.equal(walk(root).find((node) => node.dataset.focusKey === "filter-bots")?.checked, true);
      assert.equal(botsRoute.query.toString(), routeState);
      assert.deepEqual(harness.routerCalls, []);
    } finally {
      view.dispose();
      dom.restore();
    }
  });

  test("ignores a stale bootstrap response after bot option discovery is superseded", async () => {
    const dom = installFakeDom();
    const requests: string[] = [];
    let resolveWithoutBots!: (value: AnalyticsBootstrapPayload) => void;
    let resolveWithBots!: (value: AnalyticsBootstrapPayload) => void;
    const withoutBots = new Promise<AnalyticsBootstrapPayload>((resolve) => { resolveWithoutBots = resolve; });
    const withBots = new Promise<AnalyticsBootstrapPayload>((resolve) => { resolveWithBots = resolve; });
    let requestCount = 0;
    let resolveUpdate!: () => void;
    const updated = new Promise<void>((resolve) => { resolveUpdate = resolve; });
    const services = {
      api: {
        invalidate() {},
        async latest<T>(_key: string, request: string): Promise<{ data: T; generation: number; current: boolean }> {
          requests.push(request);
          requestCount += 1;
          const data = await (requestCount === 1 ? withoutBots : withBots);
          return { data: data as T, generation: requestCount, current: true };
        },
      },
      router: { updateQuery() {}, navigate() {} },
      overlays: {},
      toasts: {},
      mutations: {},
      context: { repository: "acme/example" },
      overlayRoot: globalThis.document.body,
      announce() { resolveUpdate(); },
    } as unknown as AppServices;
    const root = dom.document.createElement("main");
    const view = new AnalyticsView(root as unknown as HTMLElement, services, parseRoute({ pathname: "/analytics", search: "", hash: "" } as Location));
    try {
      view.update(parseRoute({ pathname: "/analytics", search: "?bots=true", hash: "" } as Location));
      resolveWithBots(botAwareBootstrap("/api/analytics/bootstrap?bots=true"));
      await updated;
      assert.ok(walk(root).some((node) => node.tagName === "option" && node.getAttribute("value") === "2"));

      resolveWithoutBots(bootstrap());
      await Promise.resolve();
      await Promise.resolve();

      assert.deepEqual(requests, ["/api/analytics/bootstrap", "/api/analytics/bootstrap?bots=true"]);
      assert.ok(walk(root).some((node) => node.tagName === "option" && node.getAttribute("value") === "2"));
      assert.equal(walk(root).find((node) => node.dataset.focusKey === "filter-bots")?.checked, true);
    } finally {
      view.dispose();
      dom.restore();
    }
  });

  test("uses only validated bot and timezone route settings for bootstrap option discovery", async () => {
    const dom = installFakeDom();
    const requests: string[] = [];
    const route = parseRoute({ pathname: "/analytics", search: "?timezone=Asia%2FKathmandu&bots=include&repo=evil%2Frepo&url=https%3A%2F%2Fevil.test&person=octocat", hash: "" } as Location);
    const harness = analyticsViewHarness(requests);
    const root = dom.document.createElement("main");
    const view = new AnalyticsView(root as unknown as HTMLElement, harness.services, route);
    try {
      await harness.updated();
      const bootstrapRequest = new URL(requests[0]!, "http://localhost");
      assert.equal(bootstrapRequest.pathname, "/api/analytics/bootstrap");
      assert.equal(bootstrapRequest.searchParams.get("timezone"), "Asia/Kathmandu");
      assert.equal(bootstrapRequest.searchParams.get("bots"), "true");
      assert.deepEqual([...bootstrapRequest.searchParams.keys()].sort(), ["bots", "timezone"]);
      assert.ok(walk(root).some((node) => node.tagName === "option" && node.getAttribute("value") === "Asia/Kathmandu"));
      assert.ok(walk(root).some((node) => node.tagName === "option" && node.getAttribute("value") === "1"));
    } finally {
      view.dispose();
      dom.restore();
    }
  });

  test("refreshes bootstrap and the selected section without polluting URL state, then keeps navigation cached", async () => {
    const dom = installFakeDom();
    const requests: string[] = [];
    const route = parseRoute({ pathname: "/analytics", search: "?tab=summary&range=7&label=bug", hash: "" } as Location);
    const harness = analyticsViewHarness(requests);
    const root = dom.document.createElement("main");
    const view = new AnalyticsView(root as unknown as HTMLElement, harness.services, route);
    try {
      await harness.updated();
      assert.equal(requests[0], "/api/analytics/bootstrap");
      assert.equal(new URL(requests[1]!, "http://localhost").searchParams.has("refresh"), false);

      const refresh = walk(root).find((node) => node.tagName === "button" && node.textContent === "Refresh");
      assert.ok(refresh);
      const routeState = route.query.toString();
      refresh.click();
      await harness.updated();

      const refreshed = requests.slice(-2).map((request) => new URL(request, "http://localhost"));
      assert.deepEqual(refreshed.map((request) => request.searchParams.get("refresh")), ["1", "1"]);
      assert.equal(refreshed[0]!.pathname, "/api/analytics/bootstrap");
      assert.equal(refreshed[1]!.searchParams.get("section"), "summary");
      assert.equal(route.query.toString(), routeState);
      assert.equal(route.query.has("refresh"), false);
      assert.deepEqual(harness.routerCalls, []);

      const issuesRoute = parseRoute({ pathname: "/analytics", search: "?tab=issues&range=7&label=bug", hash: "" } as Location);
      view.update(issuesRoute);
      await harness.updated();
      const navigationRequest = new URL(requests.at(-1)!, "http://localhost");
      assert.equal(navigationRequest.searchParams.get("section"), "issues");
      assert.equal(navigationRequest.searchParams.has("refresh"), false);
      assert.equal(issuesRoute.query.has("refresh"), false);
      assert.deepEqual(harness.routerCalls, []);
    } finally {
      view.dispose();
      dom.restore();
    }
  });

  test("keeps a persistent stale notice after same-section replacement fails", async () => {
    const dom = installFakeDom();
    const requests: string[] = [];
    let sectionLoads = 0;
    const harness = analyticsViewHarness(requests, (section) => {
      sectionLoads += 1;
      if (sectionLoads > 1) throw new ApiRequestError("Replacement failed", 503);
      const result = payload(section);
      result.scope = "Original result scope";
      return result;
    });
    const route = parseRoute({ pathname: "/analytics", search: "?tab=issues&range=7", hash: "" } as Location);
    const root = dom.document.createElement("main");
    const view = new AnalyticsView(root as unknown as HTMLElement, harness.services, route);
    try {
      await harness.updated();
      assert.match(root.textContent, /Original result scope/);
      view.update(parseRoute({ pathname: "/analytics", search: "?tab=issues&range=7&label=triage", hash: "" } as Location));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      assert.match(root.textContent, /Replacement failed/);
      assert.match(root.textContent, /Showing previous analytics results/);
      assert.match(root.textContent, /remain stale until a retry or filter change succeeds/);
      assert.match(root.textContent, /Original result scope/);
    } finally {
      view.dispose();
      dom.restore();
    }
  });

  test("keeps unsupported issue reviewer filters explicit and renders backend unavailability", async () => {
    const dom = installFakeDom();
    const requests: string[] = [];
    const warning = {
      code: "filter-role-inapplicable",
      message: "Reviewer attribution is unavailable for issue metrics and was not interpreted as author attribution.",
      excluded: 0,
      source: "Role filter",
    };
    const harness = analyticsViewHarness(requests, (section) => {
      const result = payload(section);
      result.metrics = [{
        id: "issues.current.open",
        label: "Open issues",
        value: null,
        unit: "issues",
        kind: "current",
        period: null,
        computedAt: result.computedAt,
        sampleSize: 0,
        numerator: null,
        denominator: null,
        previousValue: null,
        changePercent: null,
        coverage: "partial",
        warnings: [warning],
        detail: { kind: "issue", ids: [] },
        calculation: "Reviewer attribution is unavailable for issues.",
        filterBasis: "not-applicable",
      }];
      result.warnings = [warning];
      return result;
    });
    const route = parseRoute({ pathname: "/analytics", search: "?tab=issues&person=octocat&role=reviewer", hash: "" } as Location);
    const root = dom.document.createElement("main");
    const view = new AnalyticsView(root as unknown as HTMLElement, harness.services, route);
    try {
      await harness.updated();
      const reviewer = walk(root).find((node) => node.tagName === "option" && node.getAttribute("value") === "reviewer");
      assert.equal(reviewer?.disabled, true);
      const actor = walk(root).find((node) => node.tagName === "option" && node.getAttribute("value") === "actor");
      assert.equal(actor?.disabled, false);
      assert.match(actor?.textContent ?? "", /Actor — event metrics/);
      assert.match(root.textContent, /Reviewer attribution is not available for issue analytics/);
      assert.match(root.textContent, /Affected results are shown as unavailable rather than attributed to the author/);
      assert.match(root.textContent, /was not interpreted as author attribution/);
      assert.match(root.textContent, /Unavailable/);
      assert.match(root.textContent, /Filters not applicable/);
    } finally {
      view.dispose();
      dom.restore();
    }
  });
});

describe("analytics accessible data presentation", () => {
  test("renders a named native chart, drilldown marks, legend, and table alternative", () => {
    const dom = installFakeDom();
    try {
      const component = renderAnalyticsChart(chart(), () => {}, () => {}) as unknown as FakeElement;
      const graphic = component.querySelector("svg");
      assert.equal(graphic?.getAttribute("role"), "img");
      assert.ok(graphic?.getAttribute("aria-labelledby"));
      assert.equal(component.querySelectorAll('g[role="button"]').length, 2);
      assert.match(component.textContent, /View data table for Issues opened over time/);
      assert.match(component.textContent, /September 10/);
      assert.match(component.textContent, /Opened/);
    } finally { dom.restore(); }
  });

  test("renders dense, long, searchable, sortable, paginated rows without dropping full scope", () => {
    const dom = installFakeDom();
    try {
      const controller = renderAnalyticsTable(detailTable(), () => {}, () => {}) as unknown as { element: FakeElement };
      assert.match(controller.element.textContent, /Showing 1–25 of 60 matching rows · 60 total/);
      assert.equal(controller.element.querySelectorAll("tbody")[0]?.children.length, 25);
      assert.match(controller.element.textContent, /Some event pages were unavailable/);
      assert.ok(controller.element.querySelectorAll("button").some((item) => item.getAttribute("aria-label")?.startsWith("Sort Issue event details")));
    } finally { dom.restore(); }
  });

  test("keeps partial, unsupported, permission errors, and long limitations explicit", () => {
    const dom = installFakeDom();
    try {
      const sources: AnalyticsCoverageSource[] = [
        { id: "timeline", label: "Issue timeline", state: "partial", loaded: 100, knownTotal: 140, from: null, to: null, fetchedAt: "2026-09-12T00:00:00Z", excluded: 4, reason: "Some pages were unavailable", limitations: ["A long limitation ".repeat(30)] },
        { id: "stats", label: "Contributor statistics", state: "unsupported", loaded: 0, knownTotal: null, from: null, to: null, fetchedAt: "2026-09-12T00:00:00Z", excluded: 0, reason: "Unsupported for this repository", limitations: [] },
        { id: "checks", label: "Checks", state: "error", loaded: 0, knownTotal: null, from: null, to: null, fetchedAt: "2026-09-12T00:00:00Z", excluded: 0, reason: "Permission denied", limitations: [] },
      ];
      const coverage = renderCoverage(sources) as unknown as FakeElement;
      const warnings = renderWarnings(chart().warnings) as unknown as FakeElement;
      assert.match(coverage.textContent, /Partial/);
      assert.match(coverage.textContent, /Unsupported/);
      assert.match(coverage.textContent, /Permission denied/);
      assert.match(warnings.textContent, /2 records were excluded/);
    } finally { dom.restore(); }
  });


  test("renders prioritized rename and status event facts as safe text", () => {
    const dom = installFakeDom();
    try {
      const facts = renderAnalyticsDrilldownFacts({
        eventId: "event-42",
        issue: 42,
        type: "renamed",
        createdAt: "2026-09-12T09:30:00.000Z",
        actor: "octocat",
        status: "DONE",
        renameFrom: "<img src=x onerror=alert(1)> [TODO] Old title",
        renameTo: "[DONE] New title",
      }) as unknown as FakeElement;
      assert.match(facts.textContent, /StatusDONE/);
      assert.match(facts.textContent, /Previous title<img src=x onerror=alert\(1\)> \[TODO\] Old title/);
      assert.match(facts.textContent, /New title\[DONE\] New title/);
      assert.equal(facts.querySelector("img"), null);
    } finally { dom.restore(); }
  });
  test("maps drilldowns to existing issue, PR, milestone, and safe GitHub routes", () => {
    assert.equal(drilldownHref("issue-event", { issueNumber: 42 }), "/tasks?issue=42");
    assert.equal(drilldownHref("review", { pullNumber: 17 }), "/pull-requests?pr=17");
    assert.equal(drilldownHref("milestone", { milestoneNumber: 3 }), "/milestones?milestone=3");
    assert.equal(drilldownHref("release", { url: "https://github.com/acme/example/releases/tag/v1" }), "https://github.com/acme/example/releases/tag/v1");
    assert.equal(drilldownHref("release", { url: "javascript:alert(1)" }), null);
  });

  test("triggers a browser CSV download from the full payload table", () => {
    const dom = installFakeDom();
    const previousCreate = URL.createObjectURL;
    const previousRevoke = URL.revokeObjectURL;
    let created = false;
    URL.createObjectURL = () => { created = true; return "blob:analytics"; };
    URL.revokeObjectURL = () => {};
    try {
      const section = payload("issues");
      section.tables = [detailTable(2)];
      triggerAnalyticsCsv(section, "issue-events");
      assert.equal(created, true);
      assert.equal(dom.document.body.children.length, 0, "temporary download anchor is removed");
    } finally {
      URL.createObjectURL = previousCreate;
      URL.revokeObjectURL = previousRevoke;
      dom.restore();
    }
  });
});
