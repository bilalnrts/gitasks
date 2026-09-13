import { ApiRequestError, apiErrorDescription } from "../api.js";
import {
  ANALYTICS_TAB_LABELS,
  renderAnalyticsChart,
  renderAnalyticsDrilldownFacts,
  renderAnalyticsTable,
  renderCoverage,
  renderMetricCards,
  renderWarnings,
  triggerAnalyticsCsv,
} from "../components/analytics.js";
import { button, el, externalLink, formatDate, pageHeader, safeUrl, statePanel } from "../components/primitives.js";
import { isValidTimezone } from "../../../analytics/time.js";
import { ANALYTICS_SECTIONS } from "../../../analytics/types.js";
import type {
  AnalyticsBootstrapPayload,
  AnalyticsDetailRef,
  AnalyticsGrouping,
  AnalyticsRole,
  AnalyticsSection,
  AnalyticsSectionPayload,
} from "../../../analytics/types.js";
import type { AppRoute } from "../router.js";
import { setRepeated } from "../router.js";
import type { AppServices, ViewController } from "../services.js";

const RANGE_VALUES = ["7", "30", "90", "custom"] as const;
type AnalyticsRange = (typeof RANGE_VALUES)[number];

const GROUPING_VALUES: readonly AnalyticsGrouping[] = ["day", "week", "month"];
const ROLE_VALUES: readonly AnalyticsRole[] = ["author", "assignee", "reviewer", "actor"];
const SINGLETON_PARAMETERS = ["range", "from", "to", "timezone", "group", "milestone", "person", "role", "bots", "compare", "staleDays", "reviewWaitDays"] as const;
const FILTER_PARAMETERS = [...SINGLETON_PARAMETERS, "label"] as const;

interface AnalyticsSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

const UNAVAILABLE_ROLES: Partial<Record<AnalyticsSection, Partial<Record<AnalyticsRole, string>>>> = {
  issues: {
    reviewer: "Reviewer attribution is not available for issue analytics.",
  },
  contributors: {
    actor: "Actor attribution is not available for contributor analytics.",
  },
};

function analyticsRoleOptions(section: AnalyticsSection): AnalyticsSelectOption[] {
  return [{ value: "", label: "Any role" }, ...ROLE_VALUES.map((role) => {
    const unavailable = UNAVAILABLE_ROLES[section]?.[role];
    const scope = role === "author"
      ? "record metrics"
      : role === "assignee"
        ? "current metrics"
        : role === "reviewer"
          ? "review metrics"
          : "event metrics";
    return {
      value: role,
      label: `${role[0]?.toUpperCase()}${role.slice(1)} — ${unavailable ? "unavailable" : scope}`,
      disabled: Boolean(unavailable),
    };
  })];
}

function analyticsRoleFilterHint(section: AnalyticsSection, role: AnalyticsRole | null, person: string | null): string {
  if (!person) return "Select a person to apply a role. A role by itself does not narrow results.";
  if (role === null) return "Any role includes the selected person wherever a metric has defensible attribution.";
  const unavailable = UNAVAILABLE_ROLES[section]?.[role];
  if (unavailable) return `${unavailable} Affected results are shown as unavailable rather than attributed to the author.`;
  if (role === "actor") return "Actor applies only to timeline and event-backed metrics. Record and current-field metrics without actor evidence are shown as unavailable.";
  if (role === "reviewer") return "Reviewer applies only to review and review-request metrics. Metrics without reviewer evidence are shown as unavailable.";
  if (role === "assignee") return "Assignee applies only to current-field assignment metrics. Historical metrics without assignment evidence are shown as unavailable.";
  return "Author applies to record-backed metrics. Event metrics use author-scoped records only when that basis is stated on the metric.";
}

function analyticsRequestUrl(request: string, refresh: boolean): string {
  return refresh ? `${request}${request.includes("?") ? "&" : "?"}refresh=1` : request;
}

interface AnalyticsClientQuery {
  section: AnalyticsSection;
  range: AnalyticsRange;
  from: string;
  to: string;
  timezone: string;
  grouping: AnalyticsGrouping;
  milestone: number | null;
  labels: string[];
  person: string | null;
  role: AnalyticsRole | null;
  includeBots: boolean;
  compare: boolean;
  staleDays: number;
  reviewWaitDays: number;
}

interface NormalizedAnalyticsQuery {
  value: AnalyticsClientQuery;
  invalid: string[];
  request: string;
}

interface ViewError {
  kind: "permission" | "rate-limit" | "unsupported" | "error";
  message: string;
}

interface DrilldownRow {
  row: Record<string, string | number | boolean | null>;
  source: string;
}

function singleton(query: URLSearchParams, name: string, invalid: string[]): string | null {
  const values = query.getAll(name);
  if (values.length > 1) invalid.push(`${name} appeared more than once`);
  return values[0] ?? null;
}

function validDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function analyticsBootstrapRequestUrl(query: URLSearchParams, refresh: boolean): string {
  const parameters = new URLSearchParams();
  const timezoneValues = query.getAll("timezone");
  if (timezoneValues.length === 1 && timezoneValues[0] !== undefined && timezoneValues[0].length <= 200 && !/[\u0000-\u001f\u007f]/.test(timezoneValues[0]) && isValidTimezone(timezoneValues[0])) {
    parameters.set("timezone", timezoneValues[0]);
  }
  const botValues = query.getAll("bots");
  if (botValues.length === 1 && botValues[0] !== undefined) {
    const value = botValues[0];
    if (value === "true" || value === "1" || value === "include") parameters.set("bots", "true");
    else if (value === "false" || value === "0" || value === "exclude") parameters.set("bots", "false");
  }
  if (refresh) parameters.set("refresh", "1");
  const suffix = parameters.toString();
  return `/api/analytics/bootstrap${suffix ? `?${suffix}` : ""}`;
}

function calendarDateInZone(value: string, timezone: string, beforeBoundary = false): string {
  const instant = new Date(value);
  if (beforeBoundary) instant.setTime(instant.getTime() - 1);
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function periodBoundaryLabel(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en", { timeZone: timezone, dateStyle: "medium" }).format(new Date(value));
}

function booleanParameter(value: string | null, fallback: boolean, name: string, invalid: string[]): boolean {
  if (value === null) return fallback;
  if (value === "true" || value === "1" || value === "include") return true;
  if (value === "false" || value === "0" || value === "exclude") return false;
  invalid.push(`${name} had an invalid value`);
  return fallback;
}

function thresholdParameter(value: string | null, fallback: number, name: string, invalid: string[]): number {
  if (value === null) return fallback;
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 3650) return parsed;
  }
  invalid.push(`${name} had an invalid threshold`);
  return fallback;
}

export function normalizeAnalyticsQuery(query: URLSearchParams, bootstrap: AnalyticsBootstrapPayload): NormalizedAnalyticsQuery {
  const invalid: string[] = [];
  const rawTab = singleton(query, "tab", invalid);
  const section = rawTab && ANALYTICS_SECTIONS.includes(rawTab as AnalyticsSection) ? rawTab as AnalyticsSection : "summary";
  if (rawTab && rawTab !== section) invalid.push("tab was not recognized");

  const rawRange = singleton(query, "range", invalid);
  const range = rawRange && RANGE_VALUES.includes(rawRange as AnalyticsRange) ? rawRange as AnalyticsRange : "30";
  if (rawRange && rawRange !== range) invalid.push("range was not recognized");

  const rawTimezone = singleton(query, "timezone", invalid);
  const timezone = rawTimezone && isValidTimezone(rawTimezone) ? rawTimezone : bootstrap.defaults.timezone;
  if (rawTimezone && rawTimezone !== timezone) invalid.push("timezone was not valid");

  const rawGrouping = singleton(query, "group", invalid);
  const defaultGrouping: AnalyticsGrouping = range === "90" ? "week" : bootstrap.defaults.grouping;
  const grouping = rawGrouping && GROUPING_VALUES.includes(rawGrouping as AnalyticsGrouping) ? rawGrouping as AnalyticsGrouping : defaultGrouping;
  if (rawGrouping && rawGrouping !== grouping) invalid.push("group was not recognized");

  const defaultFrom = calendarDateInZone(bootstrap.defaults.from, timezone);
  const defaultTo = calendarDateInZone(bootstrap.defaults.to, timezone, true);
  const rawFrom = singleton(query, "from", invalid);
  const rawTo = singleton(query, "to", invalid);
  let from = validDate(rawFrom) ? rawFrom : defaultFrom;
  let to = validDate(rawTo) ? rawTo : defaultTo;
  if (range === "custom") {
    if (!validDate(rawFrom)) invalid.push("custom from date was missing or invalid");
    if (!validDate(rawTo)) invalid.push("custom to date was missing or invalid");
    if (from > to) {
      invalid.push("custom dates were not in chronological order");
      from = defaultFrom;
      to = defaultTo;
    }
  } else if (rawFrom || rawTo) {
    invalid.push("custom dates were ignored because range was not custom");
  }

  const rawMilestone = singleton(query, "milestone", invalid);
  const parsedMilestone = rawMilestone && /^\d+$/.test(rawMilestone) ? Number(rawMilestone) : null;
  const milestone = parsedMilestone && Number.isSafeInteger(parsedMilestone) && parsedMilestone > 0 ? parsedMilestone : bootstrap.defaults.milestone;
  if (rawMilestone && milestone !== parsedMilestone) invalid.push("milestone was invalid");

  const labels = [...new Set(query.getAll("label").map((label) => label.trim()).filter(Boolean))];
  const rawPerson = singleton(query, "person", invalid)?.trim() || null;
  const selectedPerson = rawPerson === null ? undefined : bootstrap.options.people.find((person) =>
    person.id === rawPerson || person.login.toLowerCase() === rawPerson.toLowerCase());
  const defaultPerson = bootstrap.defaults.person === null ? undefined : bootstrap.options.people.find((person) =>
    person.id === bootstrap.defaults.person || person.login.toLowerCase() === bootstrap.defaults.person!.toLowerCase());
  const person = selectedPerson?.id ?? defaultPerson?.id ?? null;
  if (rawPerson !== null && selectedPerson === undefined) invalid.push("person was not available");
  const rawRole = singleton(query, "role", invalid);
  const role = rawRole && ROLE_VALUES.includes(rawRole as AnalyticsRole) ? rawRole as AnalyticsRole : bootstrap.defaults.role;
  if (rawRole && rawRole !== role) invalid.push("role was not recognized");
  const includeBots = booleanParameter(singleton(query, "bots", invalid), bootstrap.defaults.includeBots, "bots", invalid);
  const compare = booleanParameter(singleton(query, "compare", invalid), bootstrap.defaults.compare, "compare", invalid);
  const staleDays = thresholdParameter(singleton(query, "staleDays", invalid), bootstrap.defaults.staleDays, "staleDays", invalid);
  const reviewWaitDays = thresholdParameter(singleton(query, "reviewWaitDays", invalid), bootstrap.defaults.reviewWaitDays, "reviewWaitDays", invalid);

  const value: AnalyticsClientQuery = { section, range, from, to, timezone, grouping, milestone, labels, person, role, includeBots, compare, staleDays, reviewWaitDays };
  const parameters = new URLSearchParams();
  parameters.set("section", section);
  parameters.set("range", range);
  if (range === "custom") {
    parameters.set("from", from);
    parameters.set("to", to);
  }
  parameters.set("timezone", timezone);
  parameters.set("group", grouping);
  if (milestone !== null) parameters.set("milestone", String(milestone));
  for (const label of labels) parameters.append("label", label);
  if (person) parameters.set("person", person);
  if (role) parameters.set("role", role);
  parameters.set("bots", String(includeBots));
  parameters.set("compare", String(compare));
  parameters.set("staleDays", String(staleDays));
  parameters.set("reviewWaitDays", String(reviewWaitDays));
  return { value, invalid, request: `/api/analytics?${parameters.toString()}` };
}

function sectionSupports(section: AnalyticsSection, filter: "work" | "people" | "stale" | "review"): boolean {
  if (filter === "work") return section !== "repository";
  if (filter === "people") return section !== "repository";
  if (filter === "stale") return section === "summary" || section === "issues";
  return section === "summary" || section === "pull-requests";
}

function parseRowDetail(row: Record<string, string | number | boolean | null>): { kind: string; ids: string[] } | null {
  const kind = row._detailKind;
  if (typeof kind !== "string") return null;
  const ids = String(row._detailIds ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  return ids.length ? { kind, ids } : null;
}

function numericValue(row: Record<string, string | number | boolean | null>, candidates: readonly string[]): number | null {
  for (const candidate of candidates) {
    const entry = Object.entries(row).find(([key]) => key.replace(/[^a-z]/gi, "").toLowerCase() === candidate.toLowerCase());
    if (!entry) continue;
    const matched = String(entry[1] ?? "").match(/#?(\d+)/);
    if (matched) return Number(matched[1]);
  }
  return null;
}

export function drilldownHref(kind: AnalyticsDetailRef["kind"], row: Record<string, string | number | boolean | null>): string | null {
  if (kind === "issue" || kind === "issue-event") {
    const number = numericValue(row, ["issueNumber", "issue", "number"]);
    return number ? `/tasks?issue=${number}` : null;
  }
  if (kind === "pull-request" || kind === "review") {
    const number = numericValue(row, ["pullNumber", "pullRequest", "prNumber", "number"]);
    return number ? `/pull-requests?pr=${number}` : null;
  }
  if (kind === "milestone") {
    const number = numericValue(row, ["milestoneNumber", "milestone", "number"]);
    return number ? `/milestones?milestone=${number}` : null;
  }
  for (const [key, value] of Object.entries(row)) {
    if (!key.toLowerCase().includes("url")) continue;
    const url = safeUrl(value);
    if (url) return url;
  }
  return null;
}

export class AnalyticsView implements ViewController {
  private readonly root: HTMLElement;
  private readonly services: AppServices;
  private readonly abort = new AbortController();
  private route: AppRoute;
  private bootstrap: AnalyticsBootstrapPayload | undefined;
  private payload: AnalyticsSectionPayload | undefined;
  private loadingBootstrap = true;
  private loadingSection = false;
  private error: ViewError | undefined;
  private request = "";
  private sectionGeneration = 0;
  private bootstrapGeneration = 0;
  private bootstrapScopeRequest = "";
  private advancedFiltersOpen = false;

  constructor(root: HTMLElement, services: AppServices, route: AppRoute) {
    this.root = root;
    this.services = services;
    this.route = route;
    void this.loadBootstrap();
  }

  update(route: AppRoute): void {
    this.route = route;
    const bootstrapScopeRequest = analyticsBootstrapRequestUrl(route.query, false);
    if (!this.bootstrap) {
      if (bootstrapScopeRequest !== this.bootstrapScopeRequest) void this.loadBootstrap();
      else this.render();
      return;
    }
    if (this.loadingBootstrap) {
      if (bootstrapScopeRequest !== this.bootstrapScopeRequest) void this.loadBootstrap();
      else this.render();
      return;
    }
    const normalized = normalizeAnalyticsQuery(route.query, this.bootstrap);
    if (normalized.value.includeBots !== this.bootstrap.defaults.includeBots) {
      void this.loadBootstrap();
      return;
    }
    if (normalized.request === this.request && this.payload?.section === normalized.value.section) {
      this.render();
      return;
    }
    void this.loadSection(normalized);
  }

  dispose(): void {
    this.abort.abort();
  }

  private async loadBootstrap(refresh = false): Promise<void> {
    const initial = this.bootstrap === undefined;
    const generation = ++this.bootstrapGeneration;
    const bootstrapScopeRequest = analyticsBootstrapRequestUrl(this.route.query, false);
    this.bootstrapScopeRequest = bootstrapScopeRequest;
    this.services.api.invalidate("analytics:section");
    this.sectionGeneration += 1;
    this.request = "";
    this.loadingSection = Boolean(this.bootstrap);
    this.loadingBootstrap = true;
    this.error = undefined;
    this.render();
    try {
      const result = await this.services.api.latest<AnalyticsBootstrapPayload>("analytics:bootstrap", analyticsBootstrapRequestUrl(this.route.query, refresh), { signal: this.abort.signal });
      if (!result.current || this.abort.signal.aborted || this.bootstrapGeneration !== generation) return;
      if (analyticsBootstrapRequestUrl(this.route.query, false) !== bootstrapScopeRequest) {
        void this.loadBootstrap();
        return;
      }
      this.bootstrap = result.data;
      this.loadingBootstrap = false;
      const normalized = normalizeAnalyticsQuery(this.route.query, result.data);
      const defaultRequest = normalizeAnalyticsQuery(new URLSearchParams(), result.data).request;
      const reuseCurrent = result.data.current.section === normalized.value.section && normalized.request === defaultRequest;
      if (reuseCurrent) {
        this.payload = result.data.current;
        this.request = normalized.request;
      } else if (this.payload?.section !== normalized.value.section) {
        this.payload = undefined;
      }
      this.render();
      if (initial && !refresh && reuseCurrent) {
        this.loadingSection = false;
        this.services.announce(`${ANALYTICS_TAB_LABELS[result.data.current.section]} analytics updated.`);
        this.render();
        return;
      }
      await this.loadSection(normalized, refresh);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (this.bootstrapGeneration !== generation) return;
      this.loadingBootstrap = false;
      this.loadingSection = false;
      this.error = this.describeError(error);
      this.render();
    }
  }

  private async loadSection(normalized: NormalizedAnalyticsQuery, refresh = false): Promise<void> {
    const request = normalized.request;
    const generation = ++this.sectionGeneration;
    this.request = request;
    this.error = undefined;
    this.loadingSection = true;
    if (this.payload?.section !== normalized.value.section) this.payload = undefined;
    this.render();
    try {
      const result = await this.services.api.latest<AnalyticsSectionPayload>("analytics:section", analyticsRequestUrl(request, refresh), { signal: this.abort.signal });
      if (!result.current || this.abort.signal.aborted || this.request !== request || this.sectionGeneration !== generation) return;
      this.payload = result.data;
      this.services.announce(`${ANALYTICS_TAB_LABELS[result.data.section]} analytics updated.`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (this.request === request && this.sectionGeneration === generation) this.error = this.describeError(error);
    } finally {
      if (!this.abort.signal.aborted && this.request === request && this.sectionGeneration === generation) {
        this.loadingSection = false;
        this.render();
      }
    }
  }

  private describeError(error: unknown): ViewError {
    const message = apiErrorDescription(error);
    if (error instanceof ApiRequestError) {
      if (error.status === 403 || error.status === 401 || error.permission) return { kind: "permission", message };
      if (error.status === 429 || error.code.toLowerCase().includes("rate")) return { kind: "rate-limit", message };
      if (error.unsupported || error.code.toLowerCase().includes("unsupported")) return { kind: "unsupported", message };
    }
    return { kind: "error", message };
  }

  private render(): void {
    const focused = document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement)
      ? document.activeElement.dataset.focusKey
      : undefined;
    if (this.loadingBootstrap && !this.bootstrap) {
      this.root.replaceChildren(el("div", { className: "page analytics-page" }, pageHeader("Analytics", this.services.context.repository), statePanel("loading", "Loading analytics controls", "Reading repository metadata and available filters before calculating a section…")));
      return;
    }
    if (!this.bootstrap) {
      const retry = button("Retry", { onClick: () => void this.loadBootstrap() });
      this.root.replaceChildren(el("div", { className: "page analytics-page" }, pageHeader("Analytics", this.services.context.repository), this.renderError(retry)));
      return;
    }

    const normalized = normalizeAnalyticsQuery(this.route.query, this.bootstrap);
    const refresh = button(this.loadingSection ? "Calculating…" : "Refresh", { disabled: this.loadingSection, onClick: () => void this.loadBootstrap(true) });
    refresh.dataset.focusKey = "analytics-refresh";
    const page = el("div", { className: "page page-wide analytics-page" }, pageHeader("Analytics", this.bootstrap.repository || this.services.context.repository, [refresh]), this.renderTabs(normalized.value.section), this.renderFilters(normalized));
    const results = el("section", { id: "analytics-results", className: "analytics-results", attrs: { role: "tabpanel", "aria-label": `${ANALYTICS_TAB_LABELS[normalized.value.section]} analytics results` } });
    page.append(results);
    if (normalized.invalid.length) results.append(statePanel("partial", "Some link settings were not applied", `${normalized.invalid.join("; ")}. Safe defaults are being used; change a filter to update this link.`));
    if (this.loadingSection && this.payload) results.append(statePanel("loading", "Calculating updated analytics", "The currently visible results are stale and remain available while the new filter scope is calculated."));
    if (this.error) results.append(this.renderError(button("Retry", { onClick: () => void this.loadSection(normalized) })));
    if (this.error && this.payload) results.append(statePanel("partial", "Showing previous analytics results", "The replacement request failed. These results remain stale until a retry or filter change succeeds."));
    if (!this.payload) {
      if (this.loadingSection) results.append(statePanel("loading", `Calculating ${ANALYTICS_TAB_LABELS[normalized.value.section]}`, "Loading the required GitHub sources and computing this section…"));
      this.root.replaceChildren(page);
      this.restoreFocus(focused);
      return;
    }

    results.append(this.renderScope(this.payload), renderCoverage(this.payload.coverage));
    const warnings = renderWarnings(this.payload.warnings);
    if (warnings) results.append(warnings);
    const coverageStates = new Set(this.payload.coverage.map(({ state }) => state));
    if (coverageStates.has("pending")) results.append(statePanel("partial", "Repository statistics are calculating", "GitHub accepted a statistics request but has not finished preparing that source. Other available metrics remain visible."));
    if (coverageStates.has("unsupported")) results.append(statePanel("unsupported", "Some analytics are not applicable", "GitHub does not provide every requested source for this repository or scope. Supported metrics remain available."));
    if (coverageStates.has("error")) {
      const permission = this.payload.coverage.some((source) => source.state === "error" && /permission|forbidden|access/i.test(`${source.reason} ${source.limitations.join(" ")}`));
      results.append(statePanel(permission ? "permission" : "error", permission ? "Some sources need additional permission" : "Some sources could not be loaded", "Metrics that do not depend on those sources remain available; review Data coverage for exact limitations."));
    } else if (coverageStates.has("partial")) {
      results.append(statePanel("partial", "Partial analytics coverage", "These results use the returned subset only. Exclusions and source limitations are listed below each result."));
    }

    const hasContent = this.payload.metrics.length > 0 || this.payload.charts.some((chart) => chart.series.some((series) => series.points.length)) || this.payload.tables.some((table) => table.rows.length);
    if (!hasContent) {
      const filtered = FILTER_PARAMETERS.some((parameter) => this.route.query.has(parameter));
      results.append(statePanel("empty", filtered ? "No analytics match these filters" : "No analytics in this scope", filtered ? "Clear one or more filters to broaden the returned repository scope." : "GitHub returned no records for this analytics section."));
    } else {
      if (this.payload.metrics.length) results.append(renderMetricCards(this.payload.metrics, (detail, title) => this.openDrilldown(detail, title)));
      const charts = el("div", { className: "analytics-chart-list" });
      for (const chart of this.payload.charts) charts.append(renderAnalyticsChart(chart, (detail, title) => this.openDrilldown(detail, title), (id) => this.downloadCsv(id)));
      if (this.payload.charts.length) results.append(charts);
      const tables = el("div", { className: "analytics-table-list" });
      for (const table of this.payload.tables) tables.append(renderAnalyticsTable(table, (detail, title) => this.openDrilldown(detail, title), (id) => this.downloadCsv(id)).element);
      if (this.payload.tables.length) results.append(tables);
    }
    this.root.replaceChildren(page);
    this.restoreFocus(focused);
  }

  private restoreFocus(key: string | undefined): void {
    if (!key) return;
    window.setTimeout(() => this.root.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true }), 0);
  }

  private renderError(action: HTMLElement): HTMLElement {
    const error = this.error;
    if (!error) return statePanel("error", "Analytics could not be loaded", "The request failed.", action);
    if (error.kind === "permission") return statePanel("permission", "Analytics source permission denied", error.message, action);
    if (error.kind === "rate-limit") return statePanel("error", "GitHub rate limit reached", error.message, action);
    if (error.kind === "unsupported") return statePanel("unsupported", "Analytics source unsupported", error.message, action);
    return statePanel("error", "Analytics could not be loaded", error.message, action);
  }

  private renderTabs(active: AnalyticsSection): HTMLElement {
    const list = el("div", { className: "analytics-tabs", attrs: { role: "tablist", "aria-label": "Analytics sections" } });
    for (const section of ANALYTICS_SECTIONS) {
      const query = new URLSearchParams(this.route.query);
      query.set("tab", section);
      query.delete("issue");
      query.delete("pr");
      query.delete("milestone-detail");
      const link = el("a", { text: ANALYTICS_TAB_LABELS[section], attrs: { href: `/analytics?${query.toString()}`, "data-route": "", role: "tab", "aria-controls": "analytics-results", "aria-selected": String(section === active), tabindex: section === active ? "0" : "-1" } });
      link.dataset.focusKey = `analytics-tab-${section}`;
      list.append(link);
    }
    list.addEventListener("keydown", (event) => {
      if (!(event instanceof KeyboardEvent) || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const tabs = [...list.querySelectorAll<HTMLAnchorElement>('[role="tab"]')];
      const current = tabs.indexOf(document.activeElement as HTMLAnchorElement);
      if (current < 0) return;
      event.preventDefault();
      const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[index]?.focus();
    });
    return list;
  }

  private setParameter(name: string, value: string | null, options: { repeated?: boolean } = {}): void {
    this.services.router.updateQuery((query) => {
      if (options.repeated) {
        setRepeated(query, name, value ? value.split("\u0000") : []);
      } else if (value === null || value === "") query.delete(name);
      else query.set(name, value);
      if (name === "range" && value !== "custom") {
        query.delete("from");
        query.delete("to");
      }
    });
  }

  private renderFilters(normalized: NormalizedAnalyticsQuery): HTMLElement {
    const filters = normalized.value;
    const range = this.segmentedControl("Date range", filters.range, RANGE_VALUES.map((value) => ({ value, label: value === "custom" ? "Custom" : `${value} days` })), (value) => this.setParameter("range", value));
    const grouping = this.segmentedControl("Group dates", filters.grouping, GROUPING_VALUES.map((value) => ({ value, label: value[0]?.toUpperCase() + value.slice(1) })), (value) => this.setParameter("group", value));
    const timezoneOptions = [...new Set([filters.timezone, ...this.bootstrap!.options.timezones])].map((value) => ({ value, label: value }));
    const timezone = this.selectControl("Time zone", "timezone", filters.timezone, timezoneOptions, (value) => this.setParameter("timezone", value));
    const compare = this.checkControl("Compare with previous equal period", "compare", filters.compare, (checked) => this.setParameter("compare", String(checked)));
    const primary = el("div", { className: "analytics-filter-primary" }, range, timezone, grouping, compare);
    if (filters.range === "custom") {
      primary.append(this.dateControl("From", "from", filters.from, (value) => this.setParameter("from", value)), this.dateControl("To", "to", filters.to, (value) => this.setParameter("to", value)));
    }

    const workSupported = sectionSupports(filters.section, "work");
    const peopleSupported = sectionSupports(filters.section, "people");
    const work = el("fieldset", { className: "analytics-filter-group" }, el("legend", { text: "Work scope" }));
    work.toggleAttribute("disabled", !workSupported);
    if (!workSupported) work.append(el("p", { className: "field-hint", text: "Not applicable to repository-only metrics." }));
    const milestoneOptions = [{ value: "", label: "All milestones" }, ...this.bootstrap!.options.milestones.map((item) => ({ value: String(item.number), label: item.title }))];
    if (filters.milestone !== null && !milestoneOptions.some(({ value }) => value === String(filters.milestone))) milestoneOptions.push({ value: String(filters.milestone), label: `Milestone #${filters.milestone}` });
    work.append(this.selectControl("Milestone", "milestone", filters.milestone === null ? "" : String(filters.milestone), milestoneOptions, (value) => this.setParameter("milestone", value || null)));
    const labelChoices = [...new Set([...this.bootstrap!.options.labels, ...filters.labels])];
    work.append(this.checkboxList("Labels", "label", labelChoices, filters.labels, (values) => this.setParameter("label", values.join("\u0000"), { repeated: true })));

    const people = el("fieldset", { className: "analytics-filter-group" }, el("legend", { text: "People" }));
    people.toggleAttribute("disabled", !peopleSupported);
    if (!peopleSupported) people.append(el("p", { className: "field-hint", text: "Not applicable to repository-only metrics." }));
    const peopleOptions = [{ value: "", label: "Everyone" }, ...this.bootstrap!.options.people.map((person) => ({ value: person.id, label: person.deleted ? `${person.displayName} (deleted user)` : `${person.displayName} (@${person.login})` }))];
    if (filters.person && !peopleOptions.some(({ value }) => value === filters.person)) peopleOptions.push({ value: filters.person, label: `Person ID ${filters.person}` });
    people.append(this.selectControl("Person", "person", filters.person ?? "", peopleOptions, (value) => this.setParameter("person", value || null)));
    people.append(this.selectControl("Role", "role", filters.role ?? "", analyticsRoleOptions(filters.section), (value) => this.setParameter("role", value || null), analyticsRoleFilterHint(filters.section, filters.role, filters.person)));
    people.append(this.checkControl("Include bot accounts", "bots", filters.includeBots, (checked) => this.setParameter("bots", String(checked))));

    const thresholds = el("fieldset", { className: "analytics-filter-group" }, el("legend", { text: "Thresholds" }));
    thresholds.append(this.numberControl("Stale issue after", "staleDays", filters.staleDays, "days", sectionSupports(filters.section, "stale"), (value) => this.setParameter("staleDays", value)));
    thresholds.append(this.numberControl("Long review wait after", "reviewWaitDays", filters.reviewWaitDays, "days", sectionSupports(filters.section, "review"), (value) => this.setParameter("reviewWaitDays", value)));

    const details = el("details", { className: "analytics-advanced-filters" });
    details.open = this.advancedFiltersOpen;
    details.addEventListener("toggle", () => { this.advancedFiltersOpen = details.open; });
    details.append(el("summary", { className: "button secondary", text: "More filters" }), el("div", { className: "analytics-filter-grid" }, work, people, thresholds));
    const chips = this.renderFilterChips(normalized);
    return el("section", { className: "analytics-filters", attrs: { "aria-label": "Analytics filters" } }, primary, details, chips);
  }

  private segmentedControl(label: string, value: string, options: ReadonlyArray<{ value: string; label: string }>, onChange: (value: string) => void): HTMLElement {
    const group = el("div", { className: "analytics-filter-control" }, el("span", { className: "filter-label", text: label }));
    const choices = el("div", { className: "segmented", attrs: { role: "radiogroup", "aria-label": label } });
    for (const option of options) {
      const control = button(option.label, { className: "segment", onClick: () => onChange(option.value) });
      control.setAttribute("role", "radio");
      control.setAttribute("aria-checked", String(option.value === value));
      control.dataset.focusKey = `filter-${label}-${option.value}`;
      choices.append(control);
    }
    group.append(choices);
    return group;
  }

  private selectControl(label: string, name: string, value: string, options: ReadonlyArray<AnalyticsSelectOption>, onChange: (value: string) => void, hint?: string): HTMLElement {
    const hintId = hint ? `analytics-filter-${name}-hint` : undefined;
    const select = el("select", { attrs: { "aria-label": label, ...(hintId ? { "aria-describedby": hintId } : {}) } });
    select.dataset.focusKey = `filter-${name}`;
    for (const option of options) {
      const item = el("option", { text: option.label, attrs: { value: option.value } });
      item.selected = option.value === value;
      item.disabled = option.disabled ?? false;
      select.append(item);
    }
    select.addEventListener("change", () => onChange(select.value));
    return el("label", { className: "field" }, el("span", { text: label }), select, hint && hintId ? el("span", { className: "field-hint", text: hint, id: hintId }) : null);
  }

  private dateControl(label: string, name: string, value: string, onChange: (value: string) => void): HTMLElement {
    const input = el("input", { attrs: { type: "date", value, "aria-label": `${label} date` } });
    input.value = value;
    input.dataset.focusKey = `filter-${name}`;
    input.addEventListener("change", () => onChange(input.value));
    return el("label", { className: "field" }, el("span", { text: label }), input);
  }

  private checkControl(label: string, name: string, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
    const input = el("input", { attrs: { type: "checkbox" } });
    input.checked = checked;
    input.dataset.focusKey = `filter-${name}`;
    input.addEventListener("change", () => onChange(input.checked));
    return el("label", { className: "check-field" }, input, el("span", { text: label }));
  }

  private checkboxList(label: string, name: string, choices: readonly string[], selected: readonly string[], onChange: (values: string[]) => void): HTMLElement {
    const fieldset = el("fieldset", { className: "check-group analytics-label-filter" }, el("legend", { text: label }));
    if (!choices.length) {
      fieldset.append(el("p", { className: "field-hint", text: "No values are available for this repository." }));
      fieldset.toggleAttribute("disabled", true);
      return fieldset;
    }
    for (const choice of choices) {
      const input = el("input", { attrs: { type: "checkbox", value: choice, name } });
      input.checked = selected.includes(choice);
      input.dataset.focusKey = `filter-${name}-${choice}`;
      input.addEventListener("change", () => onChange([...fieldset.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')].map(({ value }) => value)));
      fieldset.append(el("label", {}, input, el("span", { text: choice })));
    }
    return fieldset;
  }

  private numberControl(label: string, name: string, value: number, suffix: string, applicable: boolean, onChange: (value: string) => void): HTMLElement {
    const input = el("input", { attrs: { type: "number", min: "1", max: "3650", step: "1", value: String(value), "aria-label": `${label} in ${suffix}` } });
    input.value = String(value);
    input.disabled = !applicable;
    input.dataset.focusKey = `filter-${name}`;
    input.addEventListener("change", () => onChange(input.value));
    const control = el("label", { className: "field" }, el("span", { text: label }), el("span", { className: "number-with-suffix" }, input, el("span", { text: suffix })));
    if (!applicable) control.append(el("span", { className: "field-hint", text: "Not applicable on this tab." }));
    return control;
  }

  private renderFilterChips(normalized: NormalizedAnalyticsQuery): HTMLElement {
    const chips = el("div", { className: "active-filters", attrs: { "aria-label": "Active analytics filters" } });
    const query = this.route.query;
    const labelByParameter: Record<string, string> = {
      range: `Range: ${normalized.value.range === "custom" ? `${normalized.value.from} to ${normalized.value.to}` : `${normalized.value.range} days`}`,
      from: `Custom range from ${normalized.value.from}`,
      to: `Custom range through ${normalized.value.to}`,
      timezone: `Time zone: ${normalized.value.timezone}`,
      group: `Group: ${normalized.value.grouping}`,
      milestone: `Milestone: ${normalized.value.milestone ?? "all"}`,
      person: `Person: ${normalized.value.person ?? "everyone"}`,
      role: `Role: ${normalized.value.role ?? "any"}`,
      bots: normalized.value.includeBots ? "Bots included" : "Bots excluded",
      compare: normalized.value.compare ? "Comparison on" : "Comparison off",
      staleDays: `Stale: ${normalized.value.staleDays} days`,
      reviewWaitDays: `Review wait: ${normalized.value.reviewWaitDays} days`,
    };
    for (const parameter of SINGLETON_PARAMETERS) {
      if ((parameter === "from" || parameter === "to") && query.has("range")) continue;
      if (!query.has(parameter)) continue;
      const remove = button(`${labelByParameter[parameter]} ×`, { className: "filter-chip", onClick: () => this.setParameter(parameter, null) });
      remove.setAttribute("aria-label", `Remove analytics filter ${labelByParameter[parameter]}`);
      chips.append(remove);
    }
    for (const label of normalized.value.labels) {
      const remove = button(`Label: ${label} ×`, { className: "filter-chip", onClick: () => this.services.router.updateQuery((next) => setRepeated(next, "label", next.getAll("label").filter((value) => value !== label))) });
      remove.setAttribute("aria-label", `Remove analytics label filter ${label}`);
      chips.append(remove);
    }
    if (chips.childElementCount) chips.append(button("Clear filters", { className: "button link-button", onClick: () => this.services.router.navigate(`/analytics?tab=${normalized.value.section}`) }));
    else chips.append(el("span", { className: "muted", text: "No non-default filters are active." }));
    return chips;
  }

  private renderScope(payload: AnalyticsSectionPayload): HTMLElement {
    const period = `${periodBoundaryLabel(payload.period.from, payload.period.timezone)} ≤ time < ${periodBoundaryLabel(payload.period.to, payload.period.timezone)}`;
    const comparison = payload.period.previous ? ` · compared with ${periodBoundaryLabel(payload.period.previous.from, payload.period.timezone)} ≤ time < ${periodBoundaryLabel(payload.period.previous.to, payload.period.timezone)}` : "";
    return el("section", { className: "analytics-scope", attrs: { "aria-label": "Analytics scope" } },
      el("strong", { text: payload.scope }),
      el("p", { text: `${period} · ${payload.period.timezone} · grouped by ${payload.period.grouping}${comparison}${payload.period.incomplete ? " · current period is incomplete" : ""}` }),
      el("p", { className: "muted", text: `Calculated ${formatDate(payload.computedAt, { dateStyle: "medium", timeStyle: "short" })}. Current-state metrics explicitly ignore period dates.` }),
    );
  }

  private downloadCsv(tableId: string): void {
    if (!this.payload) return;
    try {
      triggerAnalyticsCsv(this.payload, tableId);
      this.services.announce("Full-scope analytics CSV download started.");
    } catch (error) {
      this.services.toasts.show(apiErrorDescription(error), { tone: "error" });
    }
  }

  private matchingRows(detail: AnalyticsDetailRef): DrilldownRow[] {
    if (!this.payload) return [];
    const matches = (row: Record<string, string | number | boolean | null>): boolean => {
      const metadata = parseRowDetail(row);
      return Boolean(metadata && (metadata.kind === detail.kind || detail.kind === "issue-event" && metadata.kind === "issue") && metadata.ids.some((id) => detail.ids.includes(id)));
    };
    const rows: DrilldownRow[] = [];
    for (const table of this.payload.tables) for (const row of table.rows) if (matches(row)) rows.push({ row, source: table.title });
    if (rows.length) return rows;
    for (const chart of this.payload.charts) for (const row of chart.tableRows) if (matches(row)) rows.push({ row, source: chart.title });
    return rows;
  }

  private openDrilldown(detail: AnalyticsDetailRef, title: string): void {
    const rows = this.matchingRows(detail);
    if (rows.length === 1 && detail.kind !== "issue-event") {
      const href = drilldownHref(detail.kind, rows[0]!.row);
      if (href?.startsWith("/")) {
        this.services.router.navigate(href);
        return;
      }
    }
    const handle = this.services.overlays.open({ title, eyebrow: "Supporting records", kind: "drawer", returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
    handle.body.append(el("p", { className: "drilldown-scope", text: `${detail.ids.length} returned source ID${detail.ids.length === 1 ? "" : "s"}. Event references remain separate records.` }));
    if (!rows.length) {
      handle.body.append(statePanel("empty", "No linked detail rows were returned", "The metric retains its exact source IDs, but this section did not include matching display rows."));
      const list = el("ul", { className: "plain-id-list" });
      for (const id of detail.ids) list.append(el("li", { text: id }));
      handle.body.append(list);
      return;
    }
    const list = el("ol", { className: "drilldown-list" });
    for (const { row, source } of rows) {
      const visibleEntries = Object.entries(row).filter(([key]) => !key.startsWith("_"));
      const primary = visibleEntries.find(([key]) => /title|name|number|issue|pull|week|tag/i.test(key)) ?? visibleEntries[0];
      const label = primary ? String(primary[1] ?? "Record") : "Record";
      const href = drilldownHref(detail.kind, row);
      let action: HTMLElement;
      if (href?.startsWith("/")) action = el("a", { className: "text-link", text: label, attrs: { href, "data-route": "" } });
      else if (href) action = externalLink(label, href);
      else action = el("strong", { text: label });
      const facts = renderAnalyticsDrilldownFacts(row);
      list.append(el("li", {}, el("article", {}, el("p", { className: "eyebrow", text: source }), action, facts)));
    }
    handle.body.append(list);
  }
}
