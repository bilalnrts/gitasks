import { parseTaskTitle, stripTaskStatusPrefixes } from "../tasks/parser.js";
import { TASK_STATUSES, statusFromLabel, type TaskStatus } from "../tasks/statuses.js";
import { analyticsBuckets, buildAnalyticsPeriod, instantInPeriod } from "./time.js";
import type {
  AnalyticsBootstrapPayload,
  AnalyticsChart,
  AnalyticsCoverageSource,
  AnalyticsCoverageState,
  AnalyticsDataset,
  AnalyticsDetailRef,
  AnalyticsEvent,
  AnalyticsFilters,
  AnalyticsIssue,
  AnalyticsMetric,
  AnalyticsPeriod,
  AnalyticsPerson,
  AnalyticsPullRequest,
  AnalyticsQuery,
  AnalyticsReview,
  AnalyticsSectionPayload,
  AnalyticsSeries,
  AnalyticsTable,
  AnalyticsUnit,
  AnalyticsWarning,
} from "./types.js";

const DAY_MS = 86_400_000;
const STATUS_TRANSITION_CLEANUP_WINDOW_MS = 5 * 60 * 1000;
const COVERAGE_RANK: Record<AnalyticsCoverageState, number> = { complete: 0, partial: 1, pending: 2, unsupported: 3, error: 4 };
const COVERAGE_HAS_VALUE: Record<AnalyticsCoverageState, boolean> = { complete: true, partial: true, pending: false, unsupported: false, error: false };
const STATUS_NAME: Record<TaskStatus, string> = {
  BACKLOG: "Backlog", TODO: "Todo", "IN PROGRESS": "In progress", REVIEW: "Review", DONE: "Done", BLOCKED: "Blocked",
};

interface MetricInput {
  id: string;
  label: string;
  value: number | null;
  unit: AnalyticsUnit;
  kind: AnalyticsMetric["kind"];
  sample: number;
  coverage: AnalyticsCoverageState;
  detailKind: AnalyticsDetailRef["kind"];
  ids: string[];
  calculation: string;
  basis: AnalyticsMetric["filterBasis"];
  period?: AnalyticsPeriod | null;
  warnings?: AnalyticsWarning[];
  numerator?: number | null;
  denominator?: number | null;
  previous?: number | null;
}

interface StatusInterval {
  issue: AnalyticsIssue;
  status: TaskStatus;
  from: number;
  to: number;
  ids: string[];
}

function unique<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const id = key(value);
    if (!seen.has(id)) {
      seen.add(id);
      result.push(value);
    }
  }
  return result;
}

export function analyticsMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export function analyticsP75(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.75) - 1]!;
}

function personId(person: AnalyticsPerson | null, missing = "deleted-user"): string {
  return person?.id ?? missing;
}

function personLabel(person: AnalyticsPerson | null, missing = "Deleted user"): string {
  return person?.displayName || person?.login || missing;
}

function matchesPerson(person: AnalyticsPerson | null, selected: string): boolean {
  return person === null ? selected === "deleted-user" : person.id === selected || person.login.toLowerCase() === selected.toLowerCase();
}

function botAllowed(person: AnalyticsPerson | null, filters: AnalyticsFilters): boolean {
  return filters.includeBots || person === null || !person.bot;
}

function matchesIssue(issue: AnalyticsIssue, filters: AnalyticsFilters): boolean {
  if (filters.milestone !== null && issue.milestone?.number !== filters.milestone) return false;
  if (filters.labels.some((label) => !issue.labels.includes(label))) return false;
  if (!botAllowed(issue.author, filters)) return false;
  if (filters.person === null) return true;
  if (filters.role === "actor") return true;
  if (filters.role === "reviewer") return false;
  if (filters.role === "assignee") return issue.assignees.some((person) => matchesPerson(person, filters.person!));
  if (filters.role === "author") return matchesPerson(issue.author, filters.person);
  return matchesPerson(issue.author, filters.person) ||
    issue.assignees.some((person) => matchesPerson(person, filters.person!));
}

function matchesPull(pull: AnalyticsPullRequest, filters: AnalyticsFilters, reviews: readonly AnalyticsReview[]): boolean {
  if (filters.milestone !== null && pull.milestone?.number !== filters.milestone) return false;
  if (filters.labels.some((label) => !pull.labels.includes(label))) return false;
  if (!botAllowed(pull.author, filters)) return false;
  if (filters.person === null) return true;
  if (filters.role === "actor") return true;
  const author = matchesPerson(pull.author, filters.person);
  const assignee = pull.assignees.some((person) => matchesPerson(person, filters.person!));
  const reviewer = pull.requestedReviewers.some((person) => matchesPerson(person, filters.person!)) ||
    reviews.some((review) => review.pullNumber === pull.number && matchesPerson(review.reviewer, filters.person!));
  if (filters.role === "author") return author;
  if (filters.role === "assignee") return assignee;
  if (filters.role === "reviewer") return reviewer;
  return author || assignee || reviewer;
}

function roleApplies(query: AnalyticsFilters, supported: readonly NonNullable<AnalyticsFilters["role"]>[]): boolean {
  if (query.person === null) return true;
  return query.role === null ? supported.length > 0 : supported.includes(query.role);
}

function inapplicableWarning(role: AnalyticsFilters["role"]): AnalyticsWarning {
  return {
    code: "filter-role-inapplicable",
    message: `The ${role ?? "any"} person role cannot be applied to this metric from the available data model; no unfiltered value was returned.`,
    excluded: 0,
    source: null,
  };
}

function limitMetricToRoles(
  value: AnalyticsMetric,
  query: AnalyticsFilters,
  supported: readonly NonNullable<AnalyticsFilters["role"]>[],
): AnalyticsMetric {
  if (roleApplies(query, supported)) return value;
  return {
    ...value,
    value: null,
    numerator: null,
    denominator: null,
    previousValue: null,
    changePercent: null,
    sampleSize: 0,
    coverage: worst(value.coverage, "partial"),
    warnings: unique([...value.warnings, inapplicableWarning(query.role)], (item) => `${item.code}:${item.source}`),
    filterBasis: "not-applicable",
    detail: { ...value.detail, ids: [] },
  };
}

function matchesIssuePersonRole(
  issue: AnalyticsIssue,
  query: AnalyticsFilters,
  supported: readonly NonNullable<AnalyticsFilters["role"]>[],
): boolean {
  if (query.person === null) return true;
  const matches = (role: NonNullable<AnalyticsFilters["role"]>): boolean => {
    if (role === "author") return matchesPerson(issue.author, query.person!);
    if (role === "assignee") {
      return issue.assignees.some((person) => botAllowed(person, query) && matchesPerson(person, query.person!));
    }
    return false;
  };
  if (query.role === null) return supported.some(matches);
  return supported.includes(query.role) && matches(query.role);
}

function matchesIssueEventPersonRole(
  issue: AnalyticsIssue,
  event: AnalyticsEvent,
  query: AnalyticsFilters,
  supported: readonly NonNullable<AnalyticsFilters["role"]>[],
): boolean {
  if (query.person === null) return true;
  const matches = (role: NonNullable<AnalyticsFilters["role"]>): boolean => {
    if (role === "actor") return botAllowed(event.actor, query) && matchesPerson(event.actor, query.person!);
    return matchesIssuePersonRole(issue, { ...query, role }, [role]);
  };
  if (query.role === null) return supported.some(matches);
  return supported.includes(query.role) && matches(query.role);
}

function matchesPullPersonRole(
  pull: AnalyticsPullRequest,
  query: AnalyticsFilters,
  reviews: readonly AnalyticsReview[],
  events: readonly AnalyticsEvent[],
  supported: readonly NonNullable<AnalyticsFilters["role"]>[],
): boolean {
  if (query.person === null) return true;
  const matches = (role: NonNullable<AnalyticsFilters["role"]>): boolean => {
    if (role === "author") return matchesPerson(pull.author, query.person!);
    if (role === "assignee") {
      return pull.assignees.some((person) => botAllowed(person, query) && matchesPerson(person, query.person!));
    }
    if (role === "reviewer") {
      return pull.requestedReviewers.some((person) => botAllowed(person, query) && matchesPerson(person, query.person!)) ||
        reviews.some((review) => review.pullNumber === pull.number && botAllowed(review.reviewer, query) && matchesPerson(review.reviewer, query.person!));
    }
    return events.some((event) =>
      event.subject === "pull-request" &&
      event.number === pull.number &&
      botAllowed(event.actor, query) &&
      matchesPerson(event.actor, query.person!));
  };
  if (query.role === null) return supported.some(matches);
  return supported.includes(query.role) && matches(query.role);
}

function matchesPullEventPersonRole(
  pull: AnalyticsPullRequest,
  event: AnalyticsEvent,
  query: AnalyticsFilters,
  supported: readonly NonNullable<AnalyticsFilters["role"]>[],
): boolean {
  if (query.person === null) return true;
  const matches = (role: NonNullable<AnalyticsFilters["role"]>): boolean => {
    if (role === "actor") return matchesPerson(event.actor, query.person!);
    if (role === "reviewer") {
      return event.reviewer !== null
        ? botAllowed(event.reviewer, query) && matchesPerson(event.reviewer, query.person!)
        : event.type === "review-submitted" && botAllowed(event.actor, query) && matchesPerson(event.actor, query.person!);
    }
    return matchesPullPersonRole(pull, { ...query, role }, [], [], [role]);
  };
  if (query.role === null) return supported.some(matches);
  return supported.includes(query.role) && matches(query.role);
}

function limitChartToRoles(
  value: AnalyticsChart,
  query: AnalyticsFilters,
  supported: readonly NonNullable<AnalyticsFilters["role"]>[],
): AnalyticsChart {
  if (roleApplies(query, supported)) return value;
  return {
    ...value,
    series: value.series.map((series) => ({ ...series, points: [] })),
    tableRows: [],
    coverage: worst(value.coverage, "partial"),
    warnings: unique([...value.warnings, inapplicableWarning(query.role)], (item) => `${item.code}:${item.source}`),
  };
}

function limitTableToRoles(
  value: AnalyticsTable,
  query: AnalyticsFilters,
  supported: readonly NonNullable<AnalyticsFilters["role"]>[],
): AnalyticsTable {
  if (roleApplies(query, supported)) return value;
  return {
    ...value,
    rows: [],
    total: 0,
    coverage: worst(value.coverage, "partial"),
    warnings: unique([...value.warnings, inapplicableWarning(query.role)], (item) => `${item.code}:${item.source}`),
  };
}

function coverageIds(words: readonly string[]): string[] {
  if (words.includes("review-request")) return ["review-requests"];
  if (words.includes("timeline") || words.includes("event")) return ["issue-events", "timelines"];
  if (words.includes("dependenc") || words.includes("block")) return ["dependencies"];
  if (words.includes("detail") || words.includes("file")) return ["pull-details"];
  if (words.includes("review")) return ["reviews"];
  if (words.includes("check")) return ["checks"];
  if (words.includes("pull")) return ["pulls"];
  if (words.includes("issue")) return ["issues"];
  if (words.includes("milestone")) return ["milestones"];
  if (words.includes("language")) return ["languages"];
  if (words.includes("release")) return ["releases"];
  if (words.includes("tag")) return ["tags"];
  if (words.includes("contributor")) return ["contributors"];
  if (words.includes("frequency") || words.includes("code")) return ["code-frequency"];
  if (words.includes("commit") || words.includes("activ")) return ["commit-activity"];
  return [...words];
}

function coverage(
  sources: readonly AnalyticsCoverageSource[],
  words: readonly string[],
  fallbackAvailable: boolean,
  base = false,
): AnalyticsCoverageState {
  const ids = coverageIds(words);
  const matching = sources.filter((source) => ids.includes(source.id.toLowerCase()));
  if (matching.length === 0) return base || fallbackAvailable ? "complete" : "unsupported";
  return matching.reduce((state, source) => COVERAGE_RANK[source.state] > COVERAGE_RANK[state] ? source.state : state, "complete" as AnalyticsCoverageState);
}

function worst(...states: AnalyticsCoverageState[]): AnalyticsCoverageState {
  return states.reduce((state, candidate) => COVERAGE_RANK[candidate] > COVERAGE_RANK[state] ? candidate : state, "complete");
}

function coverageWarnings(sources: readonly AnalyticsCoverageSource[], words: readonly string[], state: AnalyticsCoverageState): AnalyticsWarning[] {
  if (state === "complete") return [];
  const ids = coverageIds(words);
  const matching = sources.filter((source) => source.state !== "complete" && ids.includes(source.id.toLowerCase()));
  if (matching.length === 0) return [{ code: `source-${state}`, message: `Required source is ${state}; missing evidence was not treated as zero.`, excluded: 0, source: coverageIds(words)[0] ?? null }];
  return matching.map((source) => ({ code: `source-${source.state}`, message: source.reason ?? `${source.label} coverage is ${source.state}.`, excluded: source.excluded, source: source.id }));
}

function incompleteWarning(period: AnalyticsPeriod): AnalyticsWarning[] {
  return period.incomplete ? [{ code: "incomplete-period", message: "The selected range contains an unfinished local calendar period.", excluded: 0, source: null }] : [];
}

function metric(input: MetricInput, computedAt: string): AnalyticsMetric {
  const hasDefensibleValue = COVERAGE_HAS_VALUE[input.coverage] && !(input.kind === "historical" && input.coverage === "partial" && input.sample === 0);
  const value = hasDefensibleValue ? input.value : null;
  const previous = hasDefensibleValue ? input.previous ?? null : null;
  const warnings = input.warnings?.length
    ? input.warnings
    : input.coverage === "complete"
      ? []
      : [{ code: `coverage-${input.coverage}`, message: `Metric coverage is ${input.coverage}; missing evidence was not treated as zero.`, excluded: 0, source: null }];
  return {
    id: input.id,
    label: input.label,
    value,
    unit: input.unit,
    kind: input.kind,
    period: input.period ?? null,
    computedAt,
    sampleSize: input.sample,
    numerator: input.numerator ?? null,
    denominator: input.denominator ?? null,
    previousValue: previous,
    changePercent: previous === null || previous === 0 || value === null ? null : (value - previous) / Math.abs(previous) * 100,
    coverage: input.coverage,
    warnings,
    detail: { kind: input.detailKind, ids: [...new Set(input.ids)] },
    calculation: input.calculation,
    filterBasis: input.basis,
  };
}

function table(
  id: string,
  title: string,
  description: string,
  columns: AnalyticsTable["columns"],
  rows: AnalyticsTable["rows"],
  scope: string,
  state: AnalyticsCoverageState,
  warnings: AnalyticsWarning[] = [],
): AnalyticsTable {
  const resolvedWarnings = warnings.length > 0 || state === "complete" ? warnings : [{ code: `coverage-${state}`, message: `Table coverage is ${state}; missing evidence was not treated as zero.`, excluded: 0, source: null }];
  return { id, title, description, columns, rows, total: rows.length, scope, coverage: state, warnings: resolvedWarnings };
}

function chart(
  id: string,
  title: string,
  description: string,
  kind: AnalyticsChart["kind"],
  unit: AnalyticsUnit,
  series: AnalyticsSeries[],
  state: AnalyticsCoverageState,
  warnings: AnalyticsWarning[] = [],
): AnalyticsChart {
  const labels = new Map<string, string>();
  for (const item of series) for (const value of item.points) labels.set(value.key, value.label);
  const resolvedWarnings = warnings.length > 0 || state === "complete" ? warnings : [{ code: `coverage-${state}`, message: `Chart coverage is ${state}; missing evidence was not treated as zero.`, excluded: 0, source: null }];
  return {
    id, title, description, kind, unit, series, coverage: state, warnings: resolvedWarnings, zeroBaseline: true,
    tableColumns: [{ key: "key", label: "Period or group" }, ...series.map((item) => ({ key: item.id, label: item.label }))],
    tableRows: [...labels].map(([key, label]) => {
      const row: Record<string, string | number | null> = { key: label };
      for (const item of series) row[item.id] = item.points.find((value) => value.key === key)?.value ?? 0;
      return row;
    }),
  };
}

function point(key: string, label: string, value: number, kind: AnalyticsDetailRef["kind"], ids: string[]) {
  return { key, label, value, detail: { kind, ids: [...new Set(ids)] } };
}

interface StatusTransition {
  from: TaskStatus | null;
  to: TaskStatus | null;
}

function statusTransition(event: AnalyticsEvent): StatusTransition | null {
  if (event.type === "labeled" || event.type === "unlabeled") {
    const status = statusFromLabel(event.label ?? "");
    if (status === undefined) return null;
    return event.type === "labeled" ? { from: null, to: status } : { from: status, to: null };
  }
  if (event.type !== "renamed" || event.rename === null) return null;
  const from = parseTaskTitle(event.rename.from).status ?? null;
  const to = parseTaskTitle(event.rename.to).status ?? null;
  return from === to ? null : { from, to };
}

function statusIntervals(issues: readonly AnalyticsIssue[], events: readonly AnalyticsEvent[], now: Date): StatusInterval[] {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const grouped = new Map<number, AnalyticsEvent[]>();
  for (const event of events) {
    if (event.subject !== "issue" || !byNumber.has(event.number) || statusTransition(event) === null) continue;
    const values = grouped.get(event.number) ?? [];
    values.push(event);
    grouped.set(event.number, values);
  }
  const result: StatusInterval[] = [];
  const finish = (issue: AnalyticsIssue, active: { status: TaskStatus; start: AnalyticsEvent }, end: AnalyticsEvent) => {
    const from = Date.parse(active.start.createdAt);
    const to = Date.parse(end.createdAt);
    if (to >= from) result.push({ issue, status: active.status, from, to, ids: [active.start.id, end.id] });
  };
  for (const [number, values] of grouped) {
    const issue = byNumber.get(number)!;
    let active: { status: TaskStatus; start: AnalyticsEvent } | null = null;
    for (const event of values.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id))) {
      const transition = statusTransition(event)!;
      if (event.type === "unlabeled") {
        if (active?.status === transition.from) {
          finish(issue, active, event);
          active = null;
        }
        continue;
      }
      if (active !== null && active.status !== transition.to) {
        finish(issue, active, event);
        active = null;
      }
      if (transition.to !== null && active === null) active = { status: transition.to, start: event };
    }
    if (active !== null) {
      const from = Date.parse(active.start.createdAt);
      if (now.getTime() >= from) result.push({ issue, status: active.status, from, to: now.getTime(), ids: [active.start.id] });
    }
  }
  return result;
}

function verifiedCycleSamples(
  issues: readonly AnalyticsIssue[],
  events: readonly AnalyticsEvent[],
): { samples: Array<{ from: number; to: number; ids: string[] }>; invalidFacts: number } {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const grouped = new Map<number, AnalyticsEvent[]>();
  for (const event of events) {
    if (event.subject !== "issue" || !byNumber.has(event.number) ||
      event.type !== "reopened" && event.type !== "renamed" && event.type !== "labeled" && event.type !== "unlabeled") continue;
    const values = grouped.get(event.number) ?? [];
    values.push(event);
    grouped.set(event.number, values);
  }
  const samples: Array<{ from: number; to: number; ids: string[] }> = [];
  let invalidFacts = 0;
  for (const values of grouped.values()) {
    const invalidTimes = values.filter((event) => !Number.isFinite(Date.parse(event.createdAt))).length;
    if (invalidTimes > 0) {
      invalidFacts += invalidTimes;
      continue;
    }
    const ordered = values.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id));
    let active: { from: number; ids: string[] } | null = null;
    let knownStatus: TaskStatus | null = null;
    for (let index = 0; index < ordered.length; index += 1) {
      const event = ordered[index]!;
      if (event.type === "reopened") {
        active = null;
        knownStatus = null;
        continue;
      }
      const missingFact = event.type === "renamed" && event.rename === null ||
        (event.type === "labeled" || event.type === "unlabeled") && event.label === null;
      if (missingFact) {
        active = null;
        knownStatus = null;
        continue;
      }
      let transition = statusTransition(event);
      if (transition === null) continue;
      const transitionIds = [event.id];
      let assertsFrom = event.type === "unlabeled" ||
        event.type === "renamed" && transition.from !== null;

      let renameAt: number | null = null;
      if (event.type === "labeled" && transition.to !== null) {
        const renameEvent = ordered[index + 1];
        const renameTransition = renameEvent?.type === "renamed" ? statusTransition(renameEvent) : null;
        if (renameEvent !== undefined && renameTransition !== null && renameTransition.to === transition.to) {
          transition = { from: renameTransition.from, to: transition.to };
          assertsFrom = renameTransition.from !== null;
          renameAt = Date.parse(renameEvent.createdAt);
          transitionIds.push(renameEvent.id);
          index += 1;
        }
      }

      if (renameAt !== null && transition.to !== null) {
        while (true) {
          const removalEvent = ordered[index + 1];
          const removalTransition = removalEvent?.type === "unlabeled" ? statusTransition(removalEvent) : null;
          if (removalEvent === undefined || removalTransition === null || removalTransition.from === null ||
            removalTransition.from === transition.to || Date.parse(removalEvent.createdAt) - renameAt > STATUS_TRANSITION_CLEANUP_WINDOW_MS) break;
          transitionIds.push(removalEvent.id);
          index += 1;
        }
      } else {
        const removalEvent = ordered[index + 1];
        const removalTransition = removalEvent?.type === "unlabeled" ? statusTransition(removalEvent) : null;
        if (removalEvent !== undefined && removalTransition !== null && removalTransition.from !== null &&
          transition.to !== null && (!assertsFrom || removalTransition.from === transition.from)) {
          transition = { from: removalTransition.from, to: transition.to };
          assertsFrom = true;
          transitionIds.push(removalEvent.id);
          index += 1;
        }
      }

      if (transition.to === "IN PROGRESS") {
        active = { from: Date.parse(event.createdAt), ids: transitionIds };
        knownStatus = "IN PROGRESS";
        continue;
      }
      if (active === null) {
        knownStatus = transition.to;
        continue;
      }
      const inconsistentTransition = assertsFrom && transition.from !== null &&
        knownStatus !== null && transition.from !== knownStatus;
      if (inconsistentTransition) {
        invalidFacts += 1;
        active = null;
        knownStatus = transition.to;
        continue;
      }
      active.ids.push(...transitionIds);
      knownStatus = transition.to;
      if (transition.to === "DONE") {
        const to = Date.parse(event.createdAt);
        if (to >= active.from) samples.push({ from: active.from, to, ids: active.ids });
        else invalidFacts += 1;
        active = null;
      }
    }
  }
  return { samples, invalidFacts };
}

interface HistoricalIssueSnapshot {
  title: string;
  state: AnalyticsIssue["state"];
  status: TaskStatus | null;
  proven: boolean;
  eventIds: string[];
}

function historicalIssueAt(issue: AnalyticsIssue, events: readonly AnalyticsEvent[], at: number): HistoricalIssueSnapshot {
  let fullTitle = issue.fullTitle;
  let state = issue.state;
  const statuses = new Set(issue.statusLabels.map(statusFromLabel).filter((value): value is TaskStatus => value !== undefined));
  let fallbackStatus = issue.status;
  let proven = true;
  const eventIds: string[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (Date.parse(event.createdAt) <= at) continue;
    if (event.type === "renamed") {
      eventIds.push(event.id);
      if (event.rename === null) {
        proven = false;
      } else {
        if (event.rename.to !== fullTitle) proven = false;
        const currentPrefix = parseTaskTitle(fullTitle).status;
        const previousPrefix = parseTaskTitle(event.rename.from).status;
        fullTitle = event.rename.from;
        if (statuses.size === 0 && currentPrefix !== previousPrefix) fallbackStatus = previousPrefix ?? null;
      }
      continue;
    }
    if (event.type === "closed") {
      state = "open";
      eventIds.push(event.id);
      continue;
    }
    if (event.type === "reopened") {
      state = "closed";
      eventIds.push(event.id);
      continue;
    }
    if (event.type !== "labeled" && event.type !== "unlabeled") continue;
    const status = statusFromLabel(event.label ?? "");
    if (status === undefined) {
      if (event.label === null) proven = false;
      continue;
    }
    eventIds.push(event.id);
    fallbackStatus = null;
    if (event.type === "labeled") {
      if (!statuses.has(status)) proven = false;
      statuses.delete(status);
    } else {
      if (statuses.has(status)) proven = false;
      statuses.add(status);
    }
  }
  if (statuses.size > 1) proven = false;
  const titleStatus = parseTaskTitle(fullTitle).status;
  const status = statuses.size === 0
    ? titleStatus ?? fallbackStatus
    : titleStatus !== undefined && statuses.has(titleStatus)
      ? titleStatus
      : TASK_STATUSES.find((candidate) => statuses.has(candidate)) ?? null;
  return { title: stripTaskStatusPrefixes(fullTitle), state, status, proven, eventIds };
}

function statusConflictWarnings(issues: readonly AnalyticsIssue[]): AnalyticsWarning[] {
  const count = issues.filter((issue) => {
    const statuses = issue.statusLabels.map(statusFromLabel).filter((value): value is TaskStatus => value !== undefined);
    return new Set(statuses).size > 1 || statuses.length === 1 && issue.status !== null && statuses[0] !== issue.status;
  }).length;
  return count === 0 ? [] : [{ code: "status-conflict", message: "Conflicting current status evidence was resolved using the supplied record status.", excluded: count, source: "issues" }];
}

function issuePayload(dataset: AnalyticsDataset, query: AnalyticsQuery, period: AnalyticsPeriod, now: Date, computedAt: string): AnalyticsSectionPayload {
  const unscopedQuery = { ...query, person: null, role: null };
  const issues = unique(dataset.issues, (item) => String(item.id)).filter((item) => matchesIssue(item, unscopedQuery));
  const byNumber = new Map(issues.map((item) => [item.number, item]));
  const allEvents = unique(dataset.events, (item) => item.id).filter((item) =>
    item.subject === "issue" && byNumber.has(item.number) && botAllowed(item.actor, query));
  const eventsByIssue = new Map<number, AnalyticsEvent[]>();
  for (const event of allEvents) {
    const values = eventsByIssue.get(event.number) ?? [];
    values.push(event);
    eventsByIssue.set(event.number, values);
  }
  for (const values of eventsByIssue.values()) {
    values.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id));
  }
  const currentRoles = ["author", "assignee"] as const;
  const eventRoles = ["author", "actor"] as const;
  const historyRoles = ["author"] as const;
  const currentIssues = issues.filter((item) => matchesIssuePersonRole(item, query, currentRoles));
  const historyIssues = issues.filter((item) => matchesIssuePersonRole(item, query, historyRoles));
  const events = allEvents.filter((item) => matchesIssueEventPersonRole(byNumber.get(item.number)!, item, query, eventRoles));
  const eventIssueNumbers = new Set(events.map((item) => item.number));
  const recordIssues = query.person === null
    ? issues
    : query.role === "actor"
      ? issues.filter((item) => eventIssueNumbers.has(item.number))
      : query.role === null
        ? issues.filter((item) => matchesIssuePersonRole(item, query, currentRoles) || eventIssueNumbers.has(item.number))
        : currentIssues;
  const openAll = issues.filter((item) => item.state === "open");
  const open = currentIssues.filter((item) => item.state === "open");
  const issueState = coverage(dataset.coverage, ["issue"], true, true);
  const issueWarnings = coverageWarnings(dataset.coverage, ["issue"], issueState);
  const eventState = coverage(dataset.coverage, ["issue-events"], allEvents.length > 0);
  const dependencyState = coverage(dataset.coverage, ["dependenc", "block"], issues.some((item) => item.blockedBy.length > 0));
  const eventWarnings = coverageWarnings(dataset.coverage, ["issue-events"], eventState);
  const dependencyWarnings = coverageWarnings(dataset.coverage, ["dependenc", "block"], dependencyState);
  const conflicts = statusConflictWarnings(open);
  const recordUsesEvents = query.person !== null && (query.role === null || query.role === "actor");
  const recordState = recordUsesEvents ? worst(issueState, eventState) : issueState;
  const recordWarnings = unique([
    ...issueWarnings,
    ...(recordUsesEvents ? eventWarnings : []),
    ...conflicts,
  ], (item) => `${item.code}:${item.source}`);
  const opened = historyIssues.filter((item) => instantInPeriod(item.createdAt, period));
  const closed = events.filter((item) => item.type === "closed" && instantInPeriod(item.createdAt, period));
  const reopened = events.filter((item) => item.type === "reopened" && instantInPeriod(item.createdAt, period));
  const done = events.filter((item) => statusTransition(item)?.to === "DONE" && instantInPeriod(item.createdAt, period));
  const issueIdsForEvents = (values: readonly AnalyticsEvent[]) => [...new Set(values.map((event) => String(byNumber.get(event.number)!.id)))];
  const closeSamples: Array<{ event: AnalyticsEvent; issue: AnalyticsIssue; days: number }> = [];
  let excludedDurations = 0;
  for (const issue of issues) {
    let start = Date.parse(issue.createdAt);
    for (const event of eventsByIssue.get(issue.number) ?? []) {
      if (event.type !== "closed" && event.type !== "reopened") continue;
      const at = Date.parse(event.createdAt);
      if (event.type === "reopened") {
        start = at;
      } else if (Number.isFinite(start) && at >= start) {
        closeSamples.push({ event, issue, days: (at - start) / DAY_MS });
      } else {
        excludedDurations += 1;
      }
    }
  }
  const selectedEventIds = new Set(events.map((item) => item.id));
  const periodCloseSamples = closeSamples.filter((sample) =>
    selectedEventIds.has(sample.event.id) && instantInPeriod(sample.event.createdAt, period));
  const intervals = statusIntervals(historyIssues, allEvents, now);
  const cycleEvidence = verifiedCycleSamples(historyIssues, allEvents);
  const periodFrom = Date.parse(period.from);
  const periodTo = Date.parse(period.to);
  const cycles = cycleEvidence.samples.filter((sample) => sample.to >= periodFrom && sample.to < periodTo);
  const periodIntervals = intervals.flatMap((interval) => {
    const from = Math.max(interval.from, periodFrom);
    const to = Math.min(interval.to, periodTo);
    return to <= from ? [] : [{ ...interval, from, to }];
  });
  const buckets = analyticsBuckets(period, now);
  const historicalRows = historyIssues.flatMap((issue) => {
    const auditIndexes = new Set<number>(buckets.length === 0 ? [] : [0, buckets.length - 1]);
    for (const event of eventsByIssue.get(issue.number) ?? []) {
      const eventAt = Date.parse(event.createdAt);
      let low = 0;
      let high = buckets.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (eventAt < Date.parse(buckets[middle]!.to)) high = middle;
        else low = middle + 1;
      }
      if (low < buckets.length) {
        auditIndexes.add(low);
        if (low > 0) auditIndexes.add(low - 1);
      }
    }
    return [...auditIndexes].sort((left, right) => left - right).flatMap((index) => {
      const bucket = buckets[index]!;
      const at = Date.parse(bucket.to) - 1;
      return Date.parse(issue.createdAt) > at ? [] : [{ bucket, issue, snapshot: historicalIssueAt(issue, eventsByIssue.get(issue.number) ?? [], at) }];
    });
  });
  const historyIssueNumbers = new Set(historyIssues.map((item) => item.number));
  const historyEvents = allEvents.filter((event) => historyIssueNumbers.has(event.number));
  const missingStatusFacts = historyEvents.filter((event) =>
    event.type === "renamed" && event.rename === null ||
    (event.type === "labeled" || event.type === "unlabeled") && event.label === null).length;
  const unprovenSnapshots = historicalRows.filter((item) => !item.snapshot.proven).length;
  const cycleMissingFacts = missingStatusFacts + cycleEvidence.invalidFacts;
  const missingHistoryFacts = missingStatusFacts + unprovenSnapshots + cycleEvidence.invalidFacts;
  const cycleState: AnalyticsCoverageState = eventState === "complete" && cycleMissingFacts > 0 ? "partial" : eventState;
  const statusState: AnalyticsCoverageState = eventState === "complete" && missingHistoryFacts > 0 ? "partial" : eventState;
  const cycleWarnings = cycleMissingFacts === 0 ? eventWarnings : [...eventWarnings, { code: "unknown-history-facts", message: "Missing, conflicting, or invalid timeline facts make cycle continuity partial.", excluded: cycleMissingFacts, source: "issue-events" }];
  const statusWarnings = missingHistoryFacts === 0 ? eventWarnings : [...eventWarnings, { code: "unknown-history-facts", message: "Missing, conflicting, or invalid timeline facts make historical status reconstruction partial.", excluded: missingHistoryFacts, source: "issue-events" }];
  const closedIds = new Set(closed.map((item) => item.id));
  const closedWithoutDone: AnalyticsEvent[] = [];
  for (const values of eventsByIssue.values()) {
    let completed = false;
    for (const event of values) {
      if (event.type === "reopened") completed = false;
      if (statusTransition(event)?.to === "DONE") completed = true;
      if (event.type === "closed" && closedIds.has(event.id) && !completed) closedWithoutDone.push(event);
    }
  }
  const stale = open.filter((item) => now.getTime() - Date.parse(item.updatedAt) >= query.staleDays * DAY_MS);
  const openByNumber = new Map(openAll.map((item) => [item.number, item]));
  const waiting = open.filter((item) => item.blockedBy.some((number) => openByNumber.has(number)));
  const blockers = new Map<number, AnalyticsIssue[]>();
  for (const dependent of openAll) {
    for (const number of dependent.blockedBy) {
      if (!openByNumber.has(number)) continue;
      const values = blockers.get(number) ?? [];
      values.push(dependent);
      blockers.set(number, values);
    }
  }
  const multiBlockers = [...blockers].filter(([number, dependents]) => {
    const blocker = openByNumber.get(number);
    return blocker !== undefined &&
      matchesIssuePersonRole(blocker, query, currentRoles) &&
      new Set(dependents.map((item) => item.id)).size > 1;
  });
  const previous = period.previous;
  const previousOpened = previous === null ? null : historyIssues.filter((item) => instantInPeriod(item.createdAt, previous)).length;
  const previousClosed = previous === null ? null : events.filter((item) => item.type === "closed" && instantInPeriod(item.createdAt, previous)).length;
  const unavailable = (state: AnalyticsCoverageState, value: number) => state === "unsupported" || state === "error" || state === "pending" ? null : value;
  const currentMetric = (id: string, label: string, records: AnalyticsIssue[], calculation: string, warnings: AnalyticsWarning[] = []) => metric({ id, label, value: records.length, unit: "issues", kind: "current", sample: records.length, coverage: issueState, detailKind: "issue", ids: records.map((item) => String(item.id)), calculation, basis: "current-fields", warnings }, computedAt);
  const metrics: AnalyticsMetric[] = [
    currentMetric("issues.current.open", "Open issues", open, "Unique currently open non-pull-request issue database IDs."),
    currentMetric("issues.current.in_progress", "In progress", open.filter((item) => item.status === "IN PROGRESS"), "Open issues with resolved Gitasks IN PROGRESS status.", conflicts),
    currentMetric("issues.current.blocked", "Blocked status", open.filter((item) => item.status === "BLOCKED"), "Open issues with resolved Gitasks BLOCKED status.", conflicts),
    currentMetric("issues.current.unclassified", "Unclassified", open.filter((item) => item.status === null), "Open issues without a recognized Gitasks status.", conflicts),
    metric({ id: "issues.period.opened_events", label: "Issues opened", value: opened.length, unit: "count", kind: "period-event", period, sample: opened.length, previous: previousOpened, coverage: issueState, detailKind: "issue", ids: opened.map((item) => String(item.id)), calculation: "Issue created_at in [from,to).", basis: "record-fields", warnings: incompleteWarning(period) }, computedAt),
    metric({ id: "issues.period.closed_events", label: "Closing events", value: unavailable(eventState, closed.length), unit: "count", kind: "period-event", period, sample: closed.length, previous: previousClosed, coverage: eventState, detailKind: "issue-event", ids: closed.map((item) => item.id), calculation: "Timeline closed events in [from,to); repeated closes count.", basis: "event-time", warnings: [...eventWarnings, ...incompleteWarning(period)] }, computedAt),
    metric({ id: "issues.period.closed_unique", label: "Issues closed", value: unavailable(eventState, issueIdsForEvents(closed).length), unit: "issues", kind: "period-event", period, sample: issueIdsForEvents(closed).length, coverage: eventState, detailKind: "issue", ids: issueIdsForEvents(closed), calculation: "Unique issue database IDs with a closing event in the period.", basis: "event-time", warnings: eventWarnings }, computedAt),
    metric({ id: "issues.period.completed_unique", label: "Completed issues", value: unavailable(eventState, issueIdsForEvents(done).length), unit: "issues", kind: "period-event", period, sample: issueIdsForEvents(done).length, coverage: eventState, detailKind: "issue", ids: issueIdsForEvents(done), calculation: "Unique issues with a proven DONE transition in the period; GitHub CLOSED is not substituted.", basis: "event-time", warnings: eventWarnings }, computedAt),
    metric({ id: "issues.period.closed_not_completed", label: "Closed without DONE", value: unavailable(eventState, new Set(closedWithoutDone.map((item) => item.number)).size), unit: "issues", kind: "period-event", period, sample: closedWithoutDone.length, coverage: eventState, detailKind: "issue-event", ids: closedWithoutDone.map((item) => item.id), calculation: "Closing episodes without a DONE transition after the preceding reopen and no later than close.", basis: "event-time", warnings: eventWarnings }, computedAt),
    metric({ id: "issues.period.reopened_events", label: "Reopening events", value: unavailable(eventState, reopened.length), unit: "count", kind: "period-event", period, sample: reopened.length, coverage: eventState, detailKind: "issue-event", ids: reopened.map((item) => item.id), calculation: "Timeline reopened events in [from,to); repeated reopenings count.", basis: "event-time", warnings: eventWarnings }, computedAt),
    metric({ id: "issues.period.reopened_unique", label: "Reopened issues", value: unavailable(eventState, issueIdsForEvents(reopened).length), unit: "issues", kind: "period-event", period, sample: issueIdsForEvents(reopened).length, coverage: eventState, detailKind: "issue", ids: issueIdsForEvents(reopened), calculation: "Unique issues with at least one reopening event.", basis: "event-time", warnings: eventWarnings }, computedAt),
  ];
  const durationWarnings = excludedDurations === 0 ? eventWarnings : [...eventWarnings, { code: "invalid-duration", message: "Closing episodes with inverted or invalid timestamps were excluded.", excluded: excludedDurations, source: "issue-events" }];
  const durationMetric = (id: string, label: string, values: number[], ids: string[], calculation: string, percentile: "median" | "p75", state = eventState, warnings = durationWarnings) => metric({ id, label, value: percentile === "median" ? analyticsMedian(values) : analyticsP75(values), unit: "days", kind: "historical", period, sample: values.length, coverage: state, detailKind: "issue-event", ids, calculation, basis: "event-time", warnings }, computedAt);
  metrics.push(
    durationMetric("issues.duration.close.median", "Median time to close", periodCloseSamples.map((item) => item.days), periodCloseSamples.map((item) => item.event.id), "Median creation/reopen-to-close elapsed calendar days per closing episode completed in the selected period.", "median"),
    durationMetric("issues.duration.close.p75", "P75 time to close", periodCloseSamples.map((item) => item.days), periodCloseSamples.map((item) => item.event.id), "Nearest-rank P75 creation/reopen-to-close elapsed calendar days for episodes completed in the selected period.", "p75"),
    durationMetric("issues.duration.cycle.median", "Median verified cycle time", cycles.map((item) => (item.to - item.from) / DAY_MS), cycles.flatMap((item) => item.ids), "Median evidence-backed IN PROGRESS-to-DONE elapsed time for cycles completed in [from,to); intermediate statuses remain in the cycle, while reopen or a new IN PROGRESS resets it.", "median", cycleState, cycleWarnings),
    durationMetric("issues.duration.cycle.p75", "P75 verified cycle time", cycles.map((item) => (item.to - item.from) / DAY_MS), cycles.flatMap((item) => item.ids), "Nearest-rank P75 evidence-backed IN PROGRESS-to-DONE elapsed time across intermediate statuses for cycles completed in [from,to).", "p75", cycleState, cycleWarnings),
  );
  const ageValues = open.map((item) => Math.max(0, (now.getTime() - Date.parse(item.createdAt)) / DAY_MS));
  const statusAssignments = open.reduce((sum, item) => sum + Math.max(1, item.assignees.filter((person) => botAllowed(person, query)).length), 0);
  const cumulativeSnapshots = buckets.map((bucket) => {
    const at = Date.parse(bucket.to) - 1;
    const ids = Object.fromEntries(TASK_STATUSES.map((status) => [status, [] as string[]])) as Record<TaskStatus, string[]>;
    for (const issue of historyIssues) {
      if (Date.parse(issue.createdAt) > at) continue;
      const snapshot = historicalIssueAt(issue, eventsByIssue.get(issue.number) ?? [], at);
      if (snapshot.proven && snapshot.status !== null) ids[snapshot.status].push(String(issue.id));
    }
    return { bucket, ids };
  });
  const finalCumulativeIds = cumulativeSnapshots.length === 0
    ? []
    : TASK_STATUSES.flatMap((status) => cumulativeSnapshots[cumulativeSnapshots.length - 1]!.ids[status]);
  metrics.push(
    metric({ id: "issues.current.age", label: "Open issue age", value: analyticsMedian(ageValues), unit: "days", kind: "current", sample: ageValues.length, coverage: issueState, detailKind: "issue", ids: open.map((item) => String(item.id)), calculation: "Median now minus created_at for current open issues; table retains individual dates.", basis: "current-fields" }, computedAt),
    currentMetric("issues.current.stale", "Stale open issues", stale, `Open issues with now minus updated_at at least ${query.staleDays} days.`),
    metric({ id: "issues.current.status_distribution", label: "Status distribution", value: open.length, unit: "issues", kind: "current", sample: open.length, coverage: issueState, detailKind: "issue", ids: open.map((item) => String(item.id)), calculation: "One resolved status or UNCLASSIFIED per current open issue.", basis: "current-fields", warnings: conflicts }, computedAt),
    metric({ id: "issues.current.label_distribution", label: "Label distribution", value: open.reduce((sum, item) => sum + item.labels.length, 0), unit: "issues", kind: "current", sample: open.length, coverage: issueState, detailKind: "issue", ids: open.map((item) => String(item.id)), calculation: "Open issues count in every non-status label group; grouped totals may exceed unique issues.", basis: "current-fields" }, computedAt),
    metric({ id: "issues.current.assignee_distribution", label: "Assignee distribution", value: statusAssignments, unit: "issues", kind: "current", sample: open.length, coverage: issueState, detailKind: "issue", ids: open.map((item) => String(item.id)), calculation: "Open issues count once per current assignee, or once as Unassigned.", basis: "current-fields" }, computedAt),
    metric({ id: "issues.history.status_time", label: "Time in status", value: periodIntervals.reduce((sum, item) => sum + (item.to - item.from) / DAY_MS, 0), unit: "days", kind: "historical", period, sample: periodIntervals.length, coverage: statusState, detailKind: "issue-event", ids: periodIntervals.flatMap((item) => item.ids), calculation: "Sum of evidence-backed status intervals clipped to [from,to).", basis: "event-time", warnings: statusWarnings }, computedAt),
    metric({ id: "issues.history.cumulative_flow", label: "Known-history cumulative flow", value: finalCumulativeIds.length, unit: "issues", kind: "historical", period, sample: historicalRows.length, coverage: statusState, detailKind: "issue", ids: finalCumulativeIds, calculation: "Evidence-backed status replay at the final selected bucket boundary; gaps remain unknown.", basis: "event-time", warnings: statusWarnings }, computedAt),
    metric({ id: "issues.dependencies.waiting", label: "Dependency-blocked issues", value: unavailable(dependencyState, waiting.length), unit: "issues", kind: "current", sample: waiting.length, coverage: dependencyState, detailKind: "issue", ids: waiting.map((item) => String(item.id)), calculation: "Open issues with at least one currently open native blocker.", basis: "current-fields", warnings: dependencyWarnings }, computedAt),
    metric({ id: "issues.dependencies.blockers", label: "Multi-issue blockers", value: unavailable(dependencyState, multiBlockers.length), unit: "issues", kind: "current", sample: multiBlockers.length, coverage: dependencyState, detailKind: "issue", ids: multiBlockers.map(([number]) => String(openByNumber.get(number)!.id)), calculation: "Open blocker issues with more than one distinct open dependent.", basis: "current-fields", warnings: dependencyWarnings }, computedAt),
  );
  const bucketSeries = (id: string, label: string, values: Array<{ at: string; id: string }>, kind: AnalyticsDetailRef["kind"]): AnalyticsSeries => ({ id, label, unit: "count", points: buckets.map((bucket) => {
    const selected = values.filter((value) => instantInPeriod(value.at, bucket));
    return point(bucket.key, bucket.label, selected.length, kind, selected.map((value) => value.id));
  }) });
  const statusPoints = [...TASK_STATUSES, null].map((status) => {
    const records = open.filter((item) => item.status === status);
    return point(status ?? "UNCLASSIFIED", status === null ? "Unclassified" : STATUS_NAME[status], records.length, "issue", records.map((item) => String(item.id)));
  });
  const labelGroups = new Map<string, AnalyticsIssue[]>();
  const assigneeGroups = new Map<string, { label: string; issues: AnalyticsIssue[] }>();
  for (const issue of open) {
    for (const label of issue.labels) {
      const values = labelGroups.get(label) ?? [];
      values.push(issue);
      labelGroups.set(label, values);
    }
    const allowed = issue.assignees.filter((person) => botAllowed(person, query));
    if (allowed.length === 0) {
      const values = assigneeGroups.get("unassigned") ?? { label: "Unassigned", issues: [] };
      values.issues.push(issue);
      assigneeGroups.set("unassigned", values);
    }
    for (const person of allowed) {
      const values = assigneeGroups.get(person.id) ?? { label: personLabel(person), issues: [] };
      values.issues.push(issue);
      assigneeGroups.set(person.id, values);
    }
  }
  const rawCharts = [
    chart("issues.period.activity", "Issue activity", "Opened, closing, and reopening events by local calendar bucket.", "line", "count", [bucketSeries("opened", "Opened", opened.map((item) => ({ at: item.createdAt, id: String(item.id) })), "issue"), bucketSeries("closed", "Closed events", closed.map((item) => ({ at: item.createdAt, id: item.id })), "issue-event"), bucketSeries("reopened", "Reopened events", reopened.map((item) => ({ at: item.createdAt, id: item.id })), "issue-event")], worst(issueState, eventState), eventWarnings),
    chart("issues.current.status_distribution", "Status distribution", "Current open issues by resolved Gitasks status.", "bar", "issues", [{ id: "issues", label: "Issues", unit: "issues", points: statusPoints }], issueState, conflicts),
    chart("issues.current.label_distribution", "Label distribution", "Open issues appear in every applicable non-status label.", "bar", "issues", [{ id: "issues", label: "Issues", unit: "issues", points: [...labelGroups].sort(([left], [right]) => left.localeCompare(right)).map(([label, values]) => point(label, label, new Set(values.map((item) => item.id)).size, "issue", values.map((item) => String(item.id)))) }], issueState),
    chart("issues.current.assignee_distribution", "Assignee distribution", "Open issues appear once per assignee, or as Unassigned.", "bar", "issues", [{ id: "issues", label: "Issues", unit: "issues", points: [...assigneeGroups].map(([id, values]) => point(id, values.label, new Set(values.issues.map((item) => item.id)).size, "issue", values.issues.map((item) => String(item.id)))) }], issueState),
    chart("issues.history.status_time", "Time in status", "Evidence-backed elapsed calendar days by status clipped to the selected period.", "bar", "days", [{ id: "days", label: "Days", unit: "days", points: TASK_STATUSES.map((status) => { const values = periodIntervals.filter((item) => item.status === status); return point(status, STATUS_NAME[status], values.reduce((sum, item) => sum + (item.to - item.from) / DAY_MS, 0), "issue-event", values.flatMap((item) => item.ids)); }) }], statusState, statusWarnings),
    chart("issues.history.cumulative_flow", "Known-history cumulative flow", "Reconstructed status at each local calendar boundary.", "stacked-bar", "issues", TASK_STATUSES.map((status) => ({ id: status, label: STATUS_NAME[status], unit: "issues", points: cumulativeSnapshots.map(({ bucket, ids }) => point(bucket.key, bucket.label, ids[status].length, "issue", ids[status])) })), statusState, statusWarnings),
    chart("issues.dependencies.waiting", "Dependency-blocked issues", "Current open issues with native blockers.", "bar", "issues", [{ id: "issues", label: "Blocked issues", unit: "issues", points: waiting.map((item) => point(String(item.id), `#${item.number}`, 1, "issue", [String(item.id)])) }], dependencyState, dependencyWarnings),
  ];
  const issueChartRoles = (id: string): readonly NonNullable<AnalyticsFilters["role"]>[] => {
    if (id.startsWith("issues.current.") || id.startsWith("issues.dependencies.")) return currentRoles;
    if (id.startsWith("issues.history.")) return historyRoles;
    return eventRoles;
  };
  const charts = rawCharts.map((item) => limitChartToRoles(item, query, issueChartRoles(item.id)));
  const rows = recordIssues.map((item) => ({ number: item.number, title: item.title, state: item.state, status: item.status ?? "UNCLASSIFIED", author: personLabel(item.author), assignees: item.assignees.map((person) => person.login).join(", ") || "Unassigned", milestone: item.milestone?.title ?? null, createdAt: item.createdAt, updatedAt: item.updatedAt, ageDays: item.state === "open" ? Math.max(0, (now.getTime() - Date.parse(item.createdAt)) / DAY_MS) : null, url: item.url, _detailKind: "issue", _detailIds: String(item.id) }));
  const blockerRows = multiBlockers.map(([number, dependents]) => ({ blocker: number, title: openByNumber.get(number)!.title, openDependents: new Set(dependents.map((item) => item.id)).size, dependents: unique(dependents, (item) => String(item.id)).map((item) => `#${item.number}`).join(", "), _detailKind: "issue", _detailIds: [String(openByNumber.get(number)!.id), ...dependents.map((item) => String(item.id))].join(",") }));
  const eventRows = events.map((item) => ({
    eventId: item.id,
    issue: item.number,
    type: item.type,
    createdAt: item.createdAt,
    actor: personLabel(item.actor),
    label: item.label,
    status: statusTransition(item)?.to ?? null,
    renameFrom: item.rename?.from ?? null,
    renameTo: item.rename?.to ?? null,
    milestone: item.milestoneTitle,
    _detailKind: "issue-event",
    _detailIds: item.id,
  }));
  const historyTableRows = historicalRows.map(({ bucket, issue, snapshot }) => ({
    bucket: bucket.label,
    issue: issue.number,
    title: snapshot.title,
    state: snapshot.state,
    status: snapshot.status ?? "UNCLASSIFIED",
    proven: snapshot.proven && eventState === "complete",
    _detailKind: snapshot.eventIds.length === 0 ? "issue" : "issue-event",
    _detailIds: snapshot.eventIds.length === 0 ? String(issue.id) : snapshot.eventIds.join(","),
  }));
  const rawTables = [
    table("issues.records", "Issues", "Filtered issue records backing current and period metrics.", [{ key: "number", label: "Number", numeric: true }, { key: "title", label: "Title" }, { key: "state", label: "State" }, { key: "status", label: "Status" }, { key: "author", label: "Author" }, { key: "assignees", label: "Assignees" }, { key: "milestone", label: "Milestone" }, { key: "createdAt", label: "Created" }, { key: "updatedAt", label: "Updated" }, { key: "ageDays", label: "Open age days", numeric: true }, { key: "url", label: "URL" }], rows, "Filtered non-PR issues", recordState, recordWarnings),
    table("issues.closing_episodes", "Closing episodes", "Every selected-period close event and its creation/reopen-to-close duration.", [{ key: "number", label: "Issue", numeric: true }, { key: "closedAt", label: "Closed" }, { key: "days", label: "Days", numeric: true }, { key: "stateReason", label: "Current state reason" }], periodCloseSamples.map((item) => ({ number: item.issue.number, closedAt: item.event.createdAt, days: item.days, stateReason: item.issue.stateReason, _detailKind: "issue-event", _detailIds: item.event.id })), "Closing events in selected period", eventState, durationWarnings),
    table("issues.dependencies.blockers", "Multi-issue blockers", "Open blockers with multiple distinct open dependents.", [{ key: "blocker", label: "Blocker", numeric: true }, { key: "title", label: "Title" }, { key: "openDependents", label: "Open dependents", numeric: true }, { key: "dependents", label: "Dependents" }], blockerRows, "Current open dependency relations", dependencyState, dependencyWarnings),
    table("issues.events", "Issue timeline events", "Issue timeline evidence used for applicable historical calculations.", [{ key: "eventId", label: "Event ID" }, { key: "issue", label: "Issue", numeric: true }, { key: "type", label: "Type" }, { key: "createdAt", label: "Created" }, { key: "actor", label: "Actor" }, { key: "label", label: "Label" }, { key: "status", label: "Status" }, { key: "renameFrom", label: "Rename from" }, { key: "renameTo", label: "Rename to" }, { key: "milestone", label: "Milestone" }], eventRows, "Filtered issue timeline events", eventState, eventWarnings),
    table("issues.history", "Issue history audit samples", "Sparse reconstructed title, state, and Gitasks status samples at the first, last, and event-adjacent local calendar bucket boundaries; this table does not emit every bucket.", [{ key: "bucket", label: "Sampled period" }, { key: "issue", label: "Issue", numeric: true }, { key: "title", label: "Title" }, { key: "state", label: "State" }, { key: "status", label: "Status" }, { key: "proven", label: "Proven" }], historyTableRows, "Sparse first, last, and event-adjacent boundary samples for issues existing at those boundaries", statusState, statusWarnings),
  ];
  const issueTableRoles = (id: string): readonly NonNullable<AnalyticsFilters["role"]>[] => {
    if (id === "issues.records") return ["author", "assignee", "actor"];
    if (id === "issues.closing_episodes" || id === "issues.events") return eventRoles;
    if (id.startsWith("issues.dependencies.")) return currentRoles;
    return historyRoles;
  };
  const tables = rawTables.map((item) => limitTableToRoles(item, query, issueTableRoles(item.id)));
  const issueMetricRoles = (id: string): readonly NonNullable<AnalyticsFilters["role"]>[] => {
    if (id.startsWith("issues.current.") || id.startsWith("issues.dependencies.")) return currentRoles;
    if (id === "issues.period.opened_events" || id.startsWith("issues.history.") || id.includes(".cycle.")) return historyRoles;
    return eventRoles;
  };
  const resolvedMetrics = metrics.map((item) => limitMetricToRoles(item, query, issueMetricRoles(item.id)));
  const roleWarnings = [...resolvedMetrics, ...charts, ...tables]
    .flatMap((item) => item.warnings)
    .filter((item) => item.code === "filter-role-inapplicable");
  return { section: "issues", period, filters: query, computedAt, scope: "Filtered non-pull-request records and supported history", metrics: resolvedMetrics, charts, tables, coverage: dataset.coverage, warnings: unique([...eventWarnings, ...statusWarnings, ...dependencyWarnings, ...conflicts, ...roleWarnings, ...incompleteWarning(period)], (item) => `${item.code}:${item.source}`), repository: dataset.repository };
}

function submittedReview(review: AnalyticsReview): boolean {
  return review.submittedAt !== null && review.state !== "pending";
}

function decisionValidReview(review: AnalyticsReview): boolean {
  return review.submittedAt !== null && (review.state === "approved" || review.state === "changes-requested");
}

function readyStart(events: readonly AnalyticsEvent[], number: number, at: number): number | null {
  let ready: number | null = null;
  for (const event of events.filter((item) => item.subject === "pull-request" && item.number === number && Date.parse(item.createdAt) <= at && (item.type === "ready-for-review" || item.type === "converted-to-draft")).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))) {
    ready = event.type === "ready-for-review" ? Date.parse(event.createdAt) : null;
  }
  return ready;
}

function pullPayload(dataset: AnalyticsDataset, query: AnalyticsQuery, period: AnalyticsPeriod, now: Date, computedAt: string): AnalyticsSectionPayload {
  const allReviews = unique(dataset.reviews, (item) => String(item.id));
  const unscopedQuery = { ...query, person: null, role: null };
  const allPulls = unique(dataset.pullRequests, (item) => String(item.id)).filter((item) => matchesPull(item, unscopedQuery, allReviews));
  const allByNumber = new Map(allPulls.map((item) => [item.number, item]));
  const allEvents = unique(dataset.events, (item) => item.id).filter((item) =>
    item.subject === "pull-request" && allByNumber.has(item.number) && botAllowed(item.actor, query));
  const authorPulls = allPulls.filter((item) => matchesPullPersonRole(item, query, allReviews, allEvents, ["author"]));
  const currentPulls = allPulls.filter((item) => matchesPullPersonRole(item, query, allReviews, allEvents, ["author", "assignee"]));
  const reviewPulls = allPulls.filter((item) => matchesPullPersonRole(item, query, allReviews, allEvents, ["author", "reviewer"]));
  const waitingPulls = allPulls.filter((item) => matchesPullPersonRole(item, query, allReviews, allEvents, ["author", "assignee", "reviewer"]));
  const requestPulls = allPulls.filter((item) => matchesPullPersonRole(item, query, allReviews, allEvents, ["author", "assignee", "reviewer", "actor"]));
  const changePulls = allPulls.filter((item) => matchesPullPersonRole(item, query, allReviews, allEvents, ["author", "reviewer", "actor"]));
  const pulls = allPulls.filter((item) => matchesPullPersonRole(item, query, allReviews, allEvents, ["author", "assignee", "reviewer", "actor"]));
  const byNumber = new Map(allPulls.map((item) => [item.number, item]));
  const reviews = allReviews.filter((item) => {
    const pull = byNumber.get(item.pullNumber);
    if (pull === undefined || !botAllowed(item.reviewer, query)) return false;
    if (query.person === null) return true;
    const authorMatches = (query.role === null || query.role === "author") && matchesPerson(pull.author, query.person);
    const reviewerMatches = (query.role === null || query.role === "reviewer") && matchesPerson(item.reviewer, query.person);
    return authorMatches || reviewerMatches;
  });
  const events = allEvents.filter((item) =>
    matchesPullEventPersonRole(byNumber.get(item.number)!, item, query, ["author", "reviewer", "actor"]));
  const latestRequestEvents = new Map<string, AnalyticsEvent>();
  for (const event of allEvents) {
    if (event.reviewer === null || (event.type !== "review-requested" && event.type !== "review-request-removed")) continue;
    const key = `${event.number}:${event.reviewer.id}`;
    const previous = latestRequestEvents.get(key);
    if (previous === undefined || Date.parse(event.createdAt) > Date.parse(previous.createdAt) ||
      (event.createdAt === previous.createdAt && event.id.localeCompare(previous.id) > 0)) latestRequestEvents.set(key, event);
  }
  const currentReviewers = new Map(requestPulls.map((item) => {
    const includeEveryReviewer = query.person === null ||
      ((query.role === null || query.role === "author") && matchesPerson(item.author, query.person!)) ||
      ((query.role === null || query.role === "assignee") && item.assignees.some((person) => matchesPerson(person, query.person!)));
    return [
      item.number,
      item.requestedReviewers.filter((person) => {
        if (!botAllowed(person, query)) return false;
        if (includeEveryReviewer || (query.role !== "actor" && matchesPerson(person, query.person!))) return true;
        if (query.role !== null && query.role !== "actor") return false;
        const latestRequest = latestRequestEvents.get(`${item.number}:${person.id}`);
        return latestRequest?.type === "review-requested" && matchesPerson(latestRequest.actor, query.person!);
      }),
    ];
  }));
  const pullState = coverage(dataset.coverage, ["pull"], true, true);
  const reviewState = coverage(dataset.coverage, ["review"], reviews.length > 0);
  const eventState = coverage(dataset.coverage, ["timelines"], allEvents.length > 0);
  const teamRequestsApply = (pull: AnalyticsPullRequest) =>
    query.person === null ||
    ((query.role === null || query.role === "author") && matchesPerson(pull.author, query.person!)) ||
    ((query.role === null || query.role === "assignee") && pull.assignees.some((person) => matchesPerson(person, query.person!)));
  const requestSourceState = coverage(dataset.coverage, ["review-request"], requestPulls.some((item) =>
    (currentReviewers.get(item.number)?.length ?? 0) > 0 || (teamRequestsApply(item) && item.requestedTeams.length > 0)));
  const detailState = coverage(dataset.coverage, ["detail", "file"], authorPulls.some((item) => item.changedFiles !== null));
  const reviewWarnings = coverageWarnings(dataset.coverage, ["review"], reviewState);
  const eventWarnings = coverageWarnings(dataset.coverage, ["timelines"], eventState);
  const pullWarnings = coverageWarnings(dataset.coverage, ["pull"], pullState);
  const recordUsesReviews = query.person !== null && (query.role === null || query.role === "reviewer");
  const recordUsesEvents = query.person !== null && (query.role === null || query.role === "actor");
  const recordState = worst(pullState, recordUsesReviews ? reviewState : "complete", recordUsesEvents ? eventState : "complete");
  const recordWarnings = unique([
    ...pullWarnings,
    ...(recordUsesReviews ? reviewWarnings : []),
    ...(recordUsesEvents ? eventWarnings : []),
  ], (item) => `${item.code}:${item.source}`);
  const requestSourceWarnings = coverageWarnings(dataset.coverage, ["review-request"], requestSourceState);
  const detailWarnings = coverageWarnings(dataset.coverage, ["detail", "file"], detailState);
  const opened = authorPulls.filter((item) => instantInPeriod(item.createdAt, period));
  const merged = authorPulls.filter((item) => instantInPeriod(item.mergedAt, period));
  const closedUnmerged = authorPulls.filter((item) => item.mergedAt === null && instantInPeriod(item.closedAt, period));
  const open = currentPulls.filter((item) => item.state === "open");
  const changeOpen = changePulls.filter((item) => item.state === "open");
  const requestReady = requestPulls.filter((item) => item.state === "open" && !item.draft);
  const checksState = coverage(dataset.coverage, ["check"], open.length > 0);
  const checksWarnings = coverageWarnings(dataset.coverage, ["check"], checksState);
  const waiting = waitingPulls.filter((item) => item.state === "open" && !item.draft).filter((item) =>
    (currentReviewers.get(item.number)?.length ?? 0) > 0 ||
    (teamRequestsApply(item) && (item.requestedTeams.length > 0 || item.reviewState === "review-required")));
  const submittedEvents = events.filter((item) =>
    item.type === "review-submitted" &&
    (item.reviewState === "approved" || item.reviewState === "changes-requested"));
  const latest = new Map<string, { pullNumber: number; state: AnalyticsReview["state"] }>();
  for (const item of submittedEvents.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id))) {
    latest.set(`${item.number}:${personId(item.reviewer ?? item.actor)}`, { pullNumber: item.number, state: item.reviewState! });
  }
  const reviewListOnly = reviews.filter((review) => decisionValidReview(review) && !allEvents.some((item) => item.type === "review-submitted" && item.reviewId === review.id));
  if (query.person === null || query.role !== "actor") for (const review of reviewListOnly.sort((left, right) => Date.parse(left.submittedAt!) - Date.parse(right.submittedAt!) || left.id - right.id)) {
    const key = `${review.pullNumber}:${personId(review.reviewer)}`;
    if (!latest.has(key)) latest.set(key, { pullNumber: review.pullNumber, state: review.state });
  }
  const latestReviewState = worst(reviewState, eventState, reviewListOnly.length > 0 ? "partial" : "complete");
  const latestReviewWarnings = reviewListOnly.length === 0 ? [...reviewWarnings, ...eventWarnings] : [...reviewWarnings, ...eventWarnings, { code: "review-list-only", message: "Review decisions without matching review-submitted timeline events were used only as incomplete fallback evidence.", excluded: reviewListOnly.length, source: "timelines" }];
  const changeNumbers = new Set([...latest.values()].filter((item) => item.state === "changes-requested").map((item) => item.pullNumber));
  const changes = changeOpen.filter((item) => changeNumbers.has(item.number));
  const mergeDurations = merged.flatMap((item) => { const days = (Date.parse(item.mergedAt!) - Date.parse(item.createdAt)) / DAY_MS; return Number.isFinite(days) && days >= 0 ? [{ item, days }] : []; });
  const firstReviews: Array<{ pull: AnalyticsPullRequest; review: AnalyticsReview; days: number }> = [];
  const readyReviews: Array<{ pull: AnalyticsPullRequest; review: AnalyticsReview; days: number }> = [];
  for (const pull of reviewPulls) {
    const candidates = reviews.filter((item) => item.pullNumber === pull.number && decisionValidReview(item)).sort((a, b) => Date.parse(a.submittedAt!) - Date.parse(b.submittedAt!) || a.id - b.id);
    const review = candidates[0];
    if (review !== undefined) {
      const at = Date.parse(review.submittedAt!);
      const created = Date.parse(pull.createdAt);
      if (at >= created && instantInPeriod(review.submittedAt, period)) firstReviews.push({ pull, review, days: (at - created) / DAY_MS });
    }
    const readyReview = candidates.find((item) => readyStart(allEvents, pull.number, Date.parse(item.submittedAt!)) !== null);
    if (readyReview !== undefined && instantInPeriod(readyReview.submittedAt, period)) {
      const at = Date.parse(readyReview.submittedAt!);
      const readyAt = readyStart(allEvents, pull.number, at)!;
      readyReviews.push({ pull, review: readyReview, days: (at - readyAt) / DAY_MS });
    }
  }
  const readyMerges = merged.flatMap((item) => { const at = Date.parse(item.mergedAt!); const readyAt = readyStart(allEvents, item.number, at); return readyAt === null || at < readyAt ? [] : [{ item, days: (at - readyAt) / DAY_MS }]; });
  const submitted = reviews.filter((item) => submittedReview(item) && instantInPeriod(item.submittedAt, period));
  const reviewedNumbers = new Set(submitted.map((item) => item.pullNumber));
  const requests: Array<{ pull: AnalyticsPullRequest; reviewer: AnalyticsPerson; event: AnalyticsEvent | null; days: number | null }> = [];
  for (const pull of requestReady) for (const reviewer of currentReviewers.get(pull.number) ?? []) {
    const requestEvents = events.filter((event) => event.number === pull.number && event.reviewer?.id === reviewer.id && (event.type === "review-requested" || event.type === "review-request-removed")).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
    const event = requestEvents[0]?.type === "review-requested" ? requestEvents[0] : null;
    requests.push({ pull, reviewer, event, days: event === null ? null : Math.max(0, (now.getTime() - Date.parse(event.createdAt)) / DAY_MS) });
  }
  const teamRequests = requestReady.filter(teamRequestsApply).reduce((sum, item) => sum + item.requestedTeams.length, 0);
  const unknownRequests = requests.filter((item) => item.days === null).length + teamRequests;
  const requestState = worst(eventState, requestSourceState, teamRequests > 0 || unknownRequests > 0 ? "partial" : "complete");
  const requestWarnings = [
    ...eventWarnings,
    ...requestSourceWarnings,
    ...(unknownRequests === 0 ? [] : [{ code: "unknown-review-request-age", message: "Current user or team requests without attributable unmatched timeline evidence were excluded from reviewer age metrics.", excluded: unknownRequests, source: "review-requests" }]),
  ];
  const staleRequests = requests.filter((item) => item.days !== null && item.days >= query.reviewWaitDays);
  const knownRequestAges = requests.filter((item) => item.days !== null).length;
  const waitingState = worst(pullState, requestSourceState, teamRequests > 0 ? "partial" : "complete");
  const waitingWarnings = teamRequests === 0 ? requestSourceWarnings : [...requestSourceWarnings, { code: "team-review-requests", message: "Team review requests count toward waiting PRs but cannot be attributed to individual reviewers.", excluded: teamRequests, source: "review-requests" }];
  const periodPulls = unique([...opened, ...merged, ...closedUnmerged], (item) => String(item.id));
  const withFiles = periodPulls.filter((item) => item.changedFiles !== null);
  const withLines = periodPulls.filter((item) => item.additions !== null && item.deletions !== null);
  const previousCount = (select: (item: AnalyticsPullRequest) => string | null) => period.previous === null ? null : authorPulls.filter((item) => instantInPeriod(select(item), period.previous!)).length;
  const unavailable = (state: AnalyticsCoverageState, value: number | null) => state === "unsupported" || state === "error" || state === "pending" ? null : value;
  const base = (id: string, label: string, value: number, records: AnalyticsPullRequest[], calculation: string, kind: AnalyticsMetric["kind"] = "period-event", previous: number | null = null) => metric({ id, label, value, unit: "pull-requests", kind, period: kind === "current" ? null : period, sample: records.length, previous, coverage: pullState, detailKind: "pull-request", ids: records.map((item) => String(item.id)), calculation, basis: kind === "current" ? "current-fields" : "record-fields", warnings: kind === "period-event" ? incompleteWarning(period) : [] }, computedAt);
  const duration = (id: string, label: string, values: number[], ids: string[], state: AnalyticsCoverageState, warnings: AnalyticsWarning[], calculation: string) => metric({ id, label, value: unavailable(state, analyticsMedian(values)), unit: "days", kind: "historical", period, sample: values.length, coverage: state, detailKind: id.includes("review") ? "review" : "pull-request", ids, calculation, basis: id.includes("ready") ? "event-time" : "record-fields", warnings }, computedAt);
  const metrics = [
    base("prs.period.opened", "PRs opened", opened.length, opened, "Unique PRs with created_at in [from,to).", "period-event", previousCount((item) => item.createdAt)),
    base("prs.period.merged", "PRs merged", merged.length, merged, "Unique PRs with merged_at in [from,to); attribution remains PR author.", "period-event", previousCount((item) => item.mergedAt)),
    base("prs.period.closed_unmerged", "Closed without merge", closedUnmerged.length, closedUnmerged, "PRs with closed_at in period and no merged_at."),
    base("prs.current.state_distribution", "Open PR state", open.length, open, "Current open PRs split as draft or ready.", "current"),
    metric({ id: "prs.current.review_waiting", label: "Review waiting", value: unavailable(waitingState, waiting.length), unit: "pull-requests", kind: "current", sample: waiting.length, coverage: waitingState, detailKind: "pull-request", ids: waiting.map((item) => String(item.id)), calculation: "Open ready PRs with in-scope requested users, requested teams, or review-required state; reviewer filters count only that selected current reviewer and drafts are excluded.", basis: "current-fields", warnings: waitingWarnings }, computedAt),
    metric({ id: "prs.current.changes_requested", label: "Changes requested", value: unavailable(latestReviewState, changes.length), unit: "pull-requests", kind: "current", sample: latest.size, coverage: latestReviewState, detailKind: "pull-request", ids: changes.map((item) => String(item.id)), calculation: "Latest review-submitted timeline decision per reviewer ordered by event time; review-list-only decisions are incomplete fallback evidence.", basis: "event-time", warnings: latestReviewWarnings }, computedAt),
    metric({ id: "prs.current.checks_distribution", label: "Current checks", value: unavailable(checksState, open.length), unit: "pull-requests", kind: "current", sample: open.length, coverage: checksState, detailKind: "pull-request", ids: open.map((item) => String(item.id)), calculation: "Current open PR head checks states; unknown is never treated as success.", basis: "current-fields", warnings: checksWarnings }, computedAt),
    duration("prs.duration.merge.median", "Median time to merge", mergeDurations.map((item) => item.days), mergeDurations.map((item) => String(item.item.id)), pullState, [], "Median created_at-to-merged_at elapsed calendar days."),
    metric({ id: "prs.duration.merge.p75", label: "P75 time to merge", value: analyticsP75(mergeDurations.map((item) => item.days)), unit: "days", kind: "historical", period, sample: mergeDurations.length, coverage: pullState, detailKind: "pull-request", ids: mergeDurations.map((item) => String(item.item.id)), calculation: "Nearest-rank P75 created_at-to-merged_at elapsed calendar days.", basis: "record-fields" }, computedAt),
    duration("prs.duration.first_review.median", "Median time to first review", firstReviews.map((item) => item.days), firstReviews.map((item) => String(item.review.id)), reviewState, reviewWarnings, "Median created_at to first decision-valid review when that chosen review was submitted in [from,to)."),
    duration("prs.duration.ready_review.median", "Ready to first review", readyReviews.map((item) => item.days), readyReviews.map((item) => String(item.review.id)), worst(eventState, reviewState), [...eventWarnings, ...reviewWarnings], "Median proven ready episode start to the first decision-valid review inside a ready episode when that chosen review was submitted in [from,to)."),
    duration("prs.duration.ready_merge.median", "Ready to merge", readyMerges.map((item) => item.days), readyMerges.map((item) => String(item.item.id)), eventState, eventWarnings, "Median final proven ready episode start to merge; draft intervals are excluded."),
    metric({ id: "prs.reviews.submitted", label: "Submitted reviews", value: unavailable(reviewState, submitted.length), unit: "reviews", kind: "period-event", period, sample: submitted.length, coverage: reviewState, detailKind: "review", ids: submitted.map((item) => String(item.id)), calculation: "Submitted non-pending reviews in [from,to); later dismissal does not erase historical submission activity.", basis: "event-time", warnings: reviewWarnings }, computedAt),
    metric({ id: "prs.reviews.reviewed_unique", label: "PRs reviewed", value: unavailable(reviewState, reviewedNumbers.size), unit: "pull-requests", kind: "period-event", period, sample: submitted.length, coverage: reviewState, detailKind: "pull-request", ids: [...reviewedNumbers].map((number) => String(byNumber.get(number)?.id ?? number)), calculation: "Distinct PRs with at least one submitted non-pending review in the period, including reviews later dismissed.", basis: "event-time", warnings: reviewWarnings }, computedAt),
    metric({ id: "prs.current.request_wait", label: "Review request age", value: unavailable(requestState, analyticsMedian(requests.flatMap((item) => item.days === null ? [] : [item.days]))), unit: "days", kind: "current", sample: knownRequestAges, coverage: requestState, detailKind: "issue-event", ids: requests.flatMap((item) => item.event === null ? [] : [item.event.id]), calculation: "Median age since each current user's latest unmatched request event; unattributable team requests remain explicit unknown coverage.", basis: "current-fields", warnings: requestWarnings }, computedAt),
    metric({ id: "prs.current.stale_review", label: "Long-waiting review", value: unavailable(requestState, staleRequests.length), unit: "reviews", kind: "current", sample: knownRequestAges, coverage: requestState, detailKind: "issue-event", ids: staleRequests.flatMap((item) => item.event === null ? [] : [item.event.id]), calculation: `Current ready user-review requests at least ${query.reviewWaitDays} days old; team request age remains unknown.`, basis: "current-fields", warnings: requestWarnings }, computedAt),
    metric({ id: "prs.size.files", label: "Changed files distribution", value: unavailable(detailState, analyticsMedian(withFiles.map((item) => item.changedFiles!))), unit: "count", kind: "historical", period, sample: withFiles.length, coverage: detailState, detailKind: "pull-request", ids: withFiles.map((item) => String(item.id)), calculation: "Median supplied changed-file count for period PRs; missing details excluded.", basis: "record-fields", warnings: detailWarnings }, computedAt),
    metric({ id: "prs.size.lines", label: "Line change distribution", value: unavailable(detailState, withLines.reduce((sum, item) => sum + item.additions! + item.deletions!, 0)), unit: "lines", kind: "historical", period, sample: withLines.length, coverage: detailState, detailKind: "pull-request", ids: withLines.map((item) => String(item.id)), calculation: "Supplied additions plus deletions for period PRs; no effort semantics inferred.", basis: "record-fields", warnings: detailWarnings }, computedAt),
  ];
  const buckets = analyticsBuckets(period, now);
  const periodSeries = (id: string, label: string, values: Array<{ at: string; id: string }>): AnalyticsSeries => ({
    id,
    label,
    unit: "pull-requests",
    points: buckets.map((bucket) => {
      const selected = values.filter((value) => instantInPeriod(value.at, bucket));
      return point(bucket.key, bucket.label, selected.length, "pull-request", selected.map((value) => value.id));
    }),
  });
  const checks = ["success", "failure", "pending", "neutral", "unknown"] as const;
  const rawCharts = [
    chart("prs.period.activity", "Pull request activity", "Opened, merged, and closed-unmerged PRs by local calendar bucket.", "line", "pull-requests", [periodSeries("opened", "Opened", opened.map((item) => ({ at: item.createdAt, id: String(item.id) }))), periodSeries("merged", "Merged", merged.map((item) => ({ at: item.mergedAt!, id: String(item.id) }))), periodSeries("closed-unmerged", "Closed unmerged", closedUnmerged.map((item) => ({ at: item.closedAt!, id: String(item.id) })))], pullState, incompleteWarning(period)),
    chart("prs.current.state_distribution", "Open PR state", "Current open PRs split into draft and ready.", "bar", "pull-requests", [{ id: "pulls", label: "Pull requests", unit: "pull-requests", points: [true, false].map((draft) => { const values = open.filter((item) => item.draft === draft); return point(draft ? "draft" : "ready", draft ? "Draft" : "Ready", values.length, "pull-request", values.map((item) => String(item.id))); }) }], pullState),
    chart("prs.current.checks_distribution", "Current checks", "Current open PR head checks states.", "bar", "pull-requests", [{ id: "pulls", label: "Pull requests", unit: "pull-requests", points: checks.map((state) => { const values = open.filter((item) => item.checksState === state); return point(state, state, values.length, "pull-request", values.map((item) => String(item.id))); }) }], checksState, checksWarnings),
    chart("prs.size.files", "Changed files", "Changed-file counts for period PRs with detail coverage.", "distribution", "count", [{ id: "files", label: "Changed files", unit: "count", points: withFiles.map((item) => point(String(item.id), `#${item.number}`, item.changedFiles!, "pull-request", [String(item.id)])) }], detailState, detailWarnings),
    chart("prs.size.lines", "Line changes", "Additions and deletions for period PRs with detail coverage.", "bar", "lines", [{ id: "additions", label: "Additions", unit: "lines", points: withLines.map((item) => point(String(item.id), `#${item.number}`, item.additions!, "pull-request", [String(item.id)])) }, { id: "deletions", label: "Deletions", unit: "lines", points: withLines.map((item) => point(String(item.id), `#${item.number}`, item.deletions!, "pull-request", [String(item.id)])) }], detailState, detailWarnings),
  ];
  const charts = rawCharts.map((item) => limitChartToRoles(item, query,
    item.id === "prs.current.state_distribution" || item.id === "prs.current.checks_distribution"
      ? ["author", "assignee"]
      : ["author"]));
  const requestRows = [
    ...requests.map((item) => ({ pull: item.pull.number, reviewer: personLabel(item.reviewer), requestedAt: item.event?.createdAt ?? null, days: item.days, _detailKind: item.event === null ? "pull-request" : "issue-event", _detailIds: item.event?.id ?? String(item.pull.id) })),
    ...requestReady.filter(teamRequestsApply).flatMap((pull) => pull.requestedTeams.map((team) => ({ pull: pull.number, reviewer: `Team: ${team}`, requestedAt: null, days: null, _detailKind: "pull-request", _detailIds: String(pull.id) }))),
  ];
  const pullEventRows = events.map((item) => ({
    eventId: item.id,
    pull: item.number,
    type: item.type,
    createdAt: item.createdAt,
    actor: personLabel(item.actor),
    reviewer: item.reviewer === null ? null : personLabel(item.reviewer),
    reviewState: item.reviewState,
    renameFrom: item.rename?.from ?? null,
    renameTo: item.rename?.to ?? null,
    milestone: item.milestoneTitle,
    _detailKind: "issue-event",
    _detailIds: item.id,
  }));
  const rawTables = [
    table("prs.records", "Pull requests", "Filtered pull request records backing current and period metrics.", [{ key: "number", label: "Number", numeric: true }, { key: "title", label: "Title" }, { key: "state", label: "State" }, { key: "draft", label: "Draft" }, { key: "author", label: "Author" }, { key: "mergedAt", label: "Merged" }, { key: "reviewState", label: "Review state" }, { key: "checksState", label: "Checks" }, { key: "url", label: "URL" }], pulls.map((item) => ({ number: item.number, title: item.title, state: item.state, draft: item.draft, author: personLabel(item.author), mergedAt: item.mergedAt, reviewState: item.reviewState, checksState: item.checksState, url: item.url, _detailKind: "pull-request", _detailIds: String(item.id) })), "Filtered pull requests", recordState, recordWarnings),
    table("prs.reviews", "Reviews", "Review records; pending and dismissed states remain visible.", [{ key: "id", label: "Review ID", numeric: true }, { key: "pull", label: "PR", numeric: true }, { key: "reviewer", label: "Reviewer" }, { key: "state", label: "State" }, { key: "submittedAt", label: "Submitted" }, { key: "url", label: "URL" }], reviews.map((item) => ({ id: item.id, pull: item.pullNumber, reviewer: personLabel(item.reviewer), state: item.state, submittedAt: item.submittedAt, url: item.url, _detailKind: "review", _detailIds: String(item.id) })), "Reviews for filtered pull requests", reviewState, reviewWarnings),
    table("prs.review_requests", "Current review requests", "Current user and team request pairs with explicit unknown ages.", [{ key: "pull", label: "PR", numeric: true }, { key: "reviewer", label: "Reviewer or team" }, { key: "requestedAt", label: "Requested" }, { key: "days", label: "Days", numeric: true }], requestRows, "Current ready PR reviewer/team pairs", requestState, requestWarnings),
    table("prs.events", "Pull request timeline events", "Pull request timeline evidence used for ready episodes, review ordering, and request ages.", [{ key: "eventId", label: "Event ID" }, { key: "pull", label: "PR", numeric: true }, { key: "type", label: "Type" }, { key: "createdAt", label: "Created" }, { key: "actor", label: "Actor" }, { key: "reviewer", label: "Reviewer" }, { key: "reviewState", label: "Review state" }, { key: "renameFrom", label: "Rename from" }, { key: "renameTo", label: "Rename to" }, { key: "milestone", label: "Milestone" }], pullEventRows, "Filtered pull request timeline events", eventState, eventWarnings),
  ];
  const tables = rawTables.map((item) => limitTableToRoles(item, query,
    item.id === "prs.reviews"
      ? ["author", "reviewer"]
      : item.id === "prs.events"
        ? ["author", "reviewer", "actor"]
        : ["author", "assignee", "reviewer", "actor"]));
  const pullMetricRoles = (id: string): readonly NonNullable<AnalyticsFilters["role"]>[] => {
    if (id === "prs.current.changes_requested") return ["author", "reviewer", "actor"];
    if (id === "prs.current.request_wait" || id === "prs.current.stale_review") return ["author", "assignee", "reviewer", "actor"];
    if (id === "prs.current.review_waiting") return ["author", "assignee", "reviewer"];
    if (id === "prs.current.state_distribution" || id === "prs.current.checks_distribution") return ["author", "assignee"];
    if (id.includes("review") && id !== "prs.duration.ready_merge.median") return ["author", "reviewer"];
    return ["author"];
  };
  const resolvedMetrics = metrics.map((item) => limitMetricToRoles(item, query, pullMetricRoles(item.id)));
  const roleWarnings = [...resolvedMetrics, ...charts, ...tables].flatMap((item) => item.warnings).filter((item) => item.code === "filter-role-inapplicable");
  return { section: "pull-requests", period, filters: query, computedAt, scope: "Filtered pull requests, reviews, and supported timeline history", metrics: resolvedMetrics, charts, tables, coverage: dataset.coverage, warnings: unique([...reviewWarnings, ...eventWarnings, ...requestSourceWarnings, ...detailWarnings, ...checksWarnings, ...roleWarnings, ...incompleteWarning(period)], (item) => `${item.code}:${item.source}`), repository: dataset.repository };
}

interface PersonStats {
  id: string;
  label: string;
  person: AnalyticsPerson | null;
  assigned: Set<number>;
  progressing: Set<number>;
  blocked: Set<number>;
  requests: Set<string>;
  issues: Set<number>;
  pulls: Set<number>;
  merged: Set<number>;
  reviewed: Set<number>;
  reviews: Set<number>;
}

function contributorPayload(dataset: AnalyticsDataset, query: AnalyticsQuery, period: AnalyticsPeriod, now: Date, computedAt: string): AnalyticsSectionPayload {
  const unscopedQuery = { ...query, person: null, role: null };
  const issues = unique(dataset.issues, (item) => String(item.id)).filter((item) => matchesIssue(item, unscopedQuery));
  const reviews = unique(dataset.reviews, (item) => String(item.id));
  const pulls = unique(dataset.pullRequests, (item) => String(item.id)).filter((item) => matchesPull(item, unscopedQuery, reviews));
  const pullNumbers = new Set(pulls.map((item) => item.number));
  const submitted = reviews.filter((item) => pullNumbers.has(item.pullNumber) && submittedReview(item) && instantInPeriod(item.submittedAt, period) && botAllowed(item.reviewer, query));
  const people = new Map<string, PersonStats>();
  const ensure = (person: AnalyticsPerson | null, missing = "deleted-user", label = "Deleted user") => {
    const id = personId(person, missing);
    let value = people.get(id);
    if (value === undefined) {
      value = { id, label: personLabel(person, label), person, assigned: new Set(), progressing: new Set(), blocked: new Set(), requests: new Set(), issues: new Set(), pulls: new Set(), merged: new Set(), reviewed: new Set(), reviews: new Set() };
      people.set(id, value);
    }
    return value;
  };
  for (const issue of issues) {
    if (instantInPeriod(issue.createdAt, period) && botAllowed(issue.author, query)) ensure(issue.author).issues.add(issue.id);
    if (issue.state !== "open") continue;
    const assignees = issue.assignees.filter((item) => botAllowed(item, query));
    if (assignees.length === 0) ensure(null, "unassigned", "Unassigned").assigned.add(issue.id);
    for (const person of assignees) {
      const value = ensure(person);
      value.assigned.add(issue.id);
      if (issue.status === "IN PROGRESS") value.progressing.add(issue.id);
      if (issue.status === "BLOCKED") value.blocked.add(issue.id);
    }
  }
  for (const pull of pulls) {
    if (instantInPeriod(pull.createdAt, period) && botAllowed(pull.author, query)) ensure(pull.author).pulls.add(pull.id);
    if (instantInPeriod(pull.mergedAt, period) && botAllowed(pull.author, query)) ensure(pull.author).merged.add(pull.id);
    if (pull.state === "open") for (const reviewer of pull.requestedReviewers.filter((item) => botAllowed(item, query))) ensure(reviewer).requests.add(`${pull.id}:${reviewer.id}`);
  }
  for (const review of submitted) {
    const value = ensure(review.reviewer);
    value.reviewed.add(review.pullNumber);
    value.reviews.add(review.id);
  }
  if (query.person !== null) for (const [id, value] of people) if (id !== query.person && !matchesPerson(value.person, query.person)) people.delete(id);
  const values = [...people.values()];
  const issueState = coverage(dataset.coverage, ["issue"], true, true);
  const pullState = coverage(dataset.coverage, ["pull"], true, true);
  const reviewState = coverage(dataset.coverage, ["review"], submitted.length > 0);
  const requestSourceState = coverage(dataset.coverage, ["review-request"], pulls.some((item) => item.requestedReviewers.length > 0 || item.requestedTeams.length > 0));
  const teamRequests = pulls.filter((item) => item.state === "open").reduce((sum, item) => sum + item.requestedTeams.length, 0);
  const requestState = worst(pullState, requestSourceState, teamRequests > 0 ? "partial" : "complete");
  const requestWarnings = [
    ...coverageWarnings(dataset.coverage, ["review-request"], requestSourceState),
    ...(teamRequests === 0 ? [] : [{ code: "team-review-requests", message: "Team review requests are visible but cannot be attributed to individual contributor rows.", excluded: teamRequests, source: "review-requests" }]),
  ];
  const total = (select: (value: PersonStats) => Set<unknown>) => values.reduce((sum, value) => sum + select(value).size, 0);
  const ids = (select: (value: PersonStats) => Set<unknown>) => values.filter((value) => select(value).size > 0).map((value) => value.id);
  const authorTrendApplies = query.person === null || query.role === null || query.role === "author";
  const reviewerTrendApplies = query.person === null || query.role === null || query.role === "reviewer";
  const assigneeWorkApplies = query.person === null || query.role === null || query.role === "assignee";
  const collectTrendIds = (select: (value: PersonStats) => Set<number>) => {
    const result = new Set<number>();
    for (const value of values) for (const id of select(value)) result.add(id);
    return result;
  };
  const trendIssueIds = authorTrendApplies ? collectTrendIds((value) => value.issues) : new Set<number>();
  const trendPullIds = authorTrendApplies ? collectTrendIds((value) => value.pulls) : new Set<number>();
  const trendMergeIds = authorTrendApplies ? collectTrendIds((value) => value.merged) : new Set<number>();
  const trendReviewIds = reviewerTrendApplies ? collectTrendIds((value) => value.reviews) : new Set<number>();
  const trendPeople = values.filter((value) =>
    (authorTrendApplies && (value.issues.size > 0 || value.pulls.size > 0 || value.merged.size > 0)) ||
    (reviewerTrendApplies && value.reviews.size > 0));
  const trendState = authorTrendApplies
    ? reviewerTrendApplies ? worst(issueState, pullState, reviewState) : worst(issueState, pullState)
    : reviewerTrendApplies ? reviewState : "partial";
  const trendWarnings = unique([
    ...(authorTrendApplies ? [...coverageWarnings(dataset.coverage, ["issue"], issueState), ...coverageWarnings(dataset.coverage, ["pull"], pullState)] : []),
    ...(reviewerTrendApplies ? coverageWarnings(dataset.coverage, ["review"], reviewState) : []),
    ...(!authorTrendApplies && !reviewerTrendApplies ? [inapplicableWarning(query.role)] : []),
  ], (item) => `${item.code}:${item.source}`);
  const make = (id: string, label: string, select: (value: PersonStats) => Set<unknown>, unit: AnalyticsUnit, kind: AnalyticsMetric["kind"], state: AnalyticsCoverageState, calculation: string, warnings?: AnalyticsWarning[]) => metric({ id, label, value: total(select), unit, kind, period: kind === "current" ? null : period, sample: values.length, coverage: state, detailKind: "person", ids: ids(select), calculation, basis: kind === "current" ? "current-fields" : "event-time", warnings: warnings ?? coverageWarnings(dataset.coverage, id.includes("prs_") ? ["pull"] : id.includes("review") ? ["review"] : ["issue"], state) }, computedAt);
  const metrics = [
    make("people.current.assigned_open", "Assigned open issues", (value) => value.assigned, "issues", "current", issueState, "Current open issue/person pairs; Unassigned is explicit."),
    make("people.current.in_progress", "In-progress assignments", (value) => value.progressing, "issues", "current", issueState, "Current open IN PROGRESS issue/person pairs."),
    make("people.current.blocked", "Blocked assignments", (value) => value.blocked, "issues", "current", issueState, "Current open BLOCKED issue/person pairs."),
    make("people.current.review_requests", "Pending review requests", (value) => value.requests, "reviews", "current", requestState, "Current attributable user review-request pairs; requested teams remain explicit partial coverage.", requestWarnings),
    make("people.period.issues_authored", "Issues opened", (value) => value.issues, "issues", "period-event", issueState, "Period issue creations grouped by author, including deleted-user identity."),
    make("people.period.prs_authored", "PRs opened", (value) => value.pulls, "pull-requests", "period-event", pullState, "Period PR creations grouped by author."),
    make("people.period.prs_merged", "Own PRs merged", (value) => value.merged, "pull-requests", "period-event", pullState, "Period merges attributed to PR author, never merge actor."),
    make("people.period.prs_reviewed", "Different PRs reviewed", (value) => value.reviewed, "pull-requests", "period-event", reviewState, "Distinct PRs with a submitted non-pending review per reviewer; later dismissal does not erase historical activity."),
    make("people.period.reviews_submitted", "Reviews submitted", (value) => value.reviews, "reviews", "period-event", reviewState, "Submitted non-pending reviews per reviewer; dismissed reviews remain historical activity."),
    metric({ id: "people.period.contribution_trend", label: "Contribution trend", value: trendIssueIds.size + trendPullIds.size + trendMergeIds.size + trendReviewIds.size, unit: "count", kind: "period-event", period, sample: trendPeople.length, coverage: trendState, detailKind: "person", ids: trendPeople.map((value) => value.id), calculation: "Separate authored issue, authored PR, own merge, and submitted review series; person-role filters include only the attributable event family.", basis: "event-time", warnings: trendWarnings }, computedAt),
  ];
  const buckets = analyticsBuckets(period, now);
  const trendSeries = (
    id: string,
    label: string,
    entries: Array<{ at: string; id: string }>,
    kind: AnalyticsDetailRef["kind"],
  ): AnalyticsSeries => ({
    id,
    label,
    unit: "count",
    points: buckets.map((bucket) => {
      const selected = entries.filter((entry) => instantInPeriod(entry.at, bucket));
      return point(bucket.key, bucket.label, selected.length, kind, selected.map((entry) => entry.id));
    }),
  });
  const charts = [
    limitChartToRoles(chart("people.current.work", "Current work", "Assignments and review requests by stable person identity.", "bar", "count", [
      ...(assigneeWorkApplies ? [
        { id: "assigned", label: "Assigned open", unit: "issues" as const, points: values.map((value) => point(value.id, value.label, value.assigned.size, "person", [value.id])) },
        { id: "in-progress", label: "In progress", unit: "issues" as const, points: values.map((value) => point(value.id, value.label, value.progressing.size, "person", [value.id])) },
        { id: "blocked", label: "Blocked", unit: "issues" as const, points: values.map((value) => point(value.id, value.label, value.blocked.size, "person", [value.id])) },
      ] : []),
      ...(reviewerTrendApplies ? [
        { id: "requests", label: "Review requests", unit: "reviews" as const, points: values.map((value) => point(value.id, value.label, value.requests.size, "person", [value.id])) },
      ] : []),
    ], worst(issueState, pullState, requestState), requestWarnings), query, ["assignee", "reviewer"]),
    limitChartToRoles(chart("people.period.contribution_trend", "Contribution trend", "Separate contribution event families by local calendar bucket.", "line", "count", [
      ...(authorTrendApplies ? [
        trendSeries("issues", "Issues opened", issues.filter((item) => trendIssueIds.has(item.id)).map((item) => ({ at: item.createdAt, id: String(item.id) })), "issue"),
        trendSeries("pulls", "PRs opened", pulls.filter((item) => trendPullIds.has(item.id)).map((item) => ({ at: item.createdAt, id: String(item.id) })), "pull-request"),
        trendSeries("merged", "Own PRs merged", pulls.filter((item) => trendMergeIds.has(item.id)).map((item) => ({ at: item.mergedAt!, id: String(item.id) })), "pull-request"),
      ] : []),
      ...(reviewerTrendApplies ? [
        trendSeries("reviews", "Reviews submitted", submitted.filter((item) => trendReviewIds.has(item.id)).map((item) => ({ at: item.submittedAt!, id: String(item.id) })), "review"),
      ] : []),
    ], trendState, trendWarnings), query, ["author", "reviewer"]),
  ];
  const rows = values.map((value) => ({
    person: value.label,
    assigned: assigneeWorkApplies ? value.assigned.size : null,
    inProgress: assigneeWorkApplies ? value.progressing.size : null,
    blocked: assigneeWorkApplies ? value.blocked.size : null,
    reviewRequests: reviewerTrendApplies ? value.requests.size : null,
    issuesAuthored: authorTrendApplies ? value.issues.size : null,
    prsAuthored: authorTrendApplies ? value.pulls.size : null,
    prsMerged: authorTrendApplies ? value.merged.size : null,
    prsReviewed: reviewerTrendApplies ? value.reviewed.size : null,
    reviews: reviewerTrendApplies ? value.reviews.size : null,
    _detailKind: "person",
    _detailIds: value.id,
  }));
  const tables = [limitTableToRoles(table("people.contributors", "Contributors", "Current work and period event families by stable identity.", [{ key: "person", label: "Person" }, { key: "assigned", label: "Assigned", numeric: true }, { key: "inProgress", label: "In progress", numeric: true }, { key: "blocked", label: "Blocked", numeric: true }, { key: "reviewRequests", label: "Review requests", numeric: true }, { key: "issuesAuthored", label: "Issues opened", numeric: true }, { key: "prsAuthored", label: "PRs opened", numeric: true }, { key: "prsMerged", label: "PRs merged", numeric: true }, { key: "prsReviewed", label: "PRs reviewed", numeric: true }, { key: "reviews", label: "Reviews", numeric: true }], rows, "Stable people plus explicit deleted and Unassigned identities", worst(issueState, pullState, reviewState, requestState), unique([...coverageWarnings(dataset.coverage, ["issue"], issueState), ...coverageWarnings(dataset.coverage, ["pull"], pullState), ...coverageWarnings(dataset.coverage, ["review"], reviewState), ...requestWarnings], (item) => `${item.code}:${item.source}`)), query, ["author", "assignee", "reviewer"])];
  const contributorMetricRoles = (id: string): readonly NonNullable<AnalyticsFilters["role"]>[] => {
    if (id === "people.current.assigned_open" || id === "people.current.in_progress" || id === "people.current.blocked") return ["assignee"];
    if (id === "people.current.review_requests" || id === "people.period.prs_reviewed" || id === "people.period.reviews_submitted") return ["reviewer"];
    if (id === "people.period.contribution_trend") return ["author", "reviewer"];
    return ["author"];
  };
  const resolvedMetrics = metrics.map((item) => limitMetricToRoles(item, query, contributorMetricRoles(item.id)));
  const roleWarnings = [...resolvedMetrics, ...charts, ...tables].flatMap((item) => item.warnings).filter((item) => item.code === "filter-role-inapplicable");
  return { section: "contributors", period, filters: query, computedAt, scope: "Filtered current assignments and period contribution events", metrics: resolvedMetrics, charts, tables, coverage: dataset.coverage, warnings: unique([...coverageWarnings(dataset.coverage, ["review"], reviewState), ...requestWarnings, ...roleWarnings, ...incompleteWarning(period)], (item) => `${item.code}:${item.source}`), repository: dataset.repository };
}

function milestonePayload(dataset: AnalyticsDataset, query: AnalyticsQuery, period: AnalyticsPeriod, now: Date, computedAt: string): AnalyticsSectionPayload {
  const milestones = unique(dataset.milestones, (item) => String(item.number)).filter((item) => query.milestone === null || item.number === query.milestone);
  const selectedMilestone = query.milestone === null ? null : milestones[0];
  const selectedTitle = selectedMilestone?.title;
  const missingSelectedMilestone = query.milestone !== null && selectedMilestone === undefined;
  const unscopedQuery = { ...query, milestone: null, person: null, role: null };
  const allIssues = unique(dataset.issues, (item) => String(item.id)).filter((item) => matchesIssue(item, unscopedQuery));
  const issuesByNumber = new Map(allIssues.map((item) => [item.number, item]));
  const issues = allIssues.filter((item) =>
    matchesIssuePersonRole(item, query, ["author", "assignee"]) &&
    item.milestone !== null &&
    (query.milestone === null || item.milestone.number === query.milestone));
  const reviews = unique(dataset.reviews, (item) => String(item.id));
  const pullEvents = unique(dataset.events, (item) => item.id).filter((item) => item.subject === "pull-request");
  const pulls = unique(dataset.pullRequests, (item) => String(item.id)).filter((item) =>
    matchesPull(item, unscopedQuery, reviews) &&
    matchesPullPersonRole(item, query, reviews, pullEvents, ["author", "assignee"]) &&
    item.milestone !== null &&
    (query.milestone === null || item.milestone.number === query.milestone));
  const issueNumbers = new Set(allIssues.map((item) => item.number));
  const allEvents = unique(dataset.events, (item) => item.id).filter((item) =>
    item.subject === "issue" &&
    issueNumbers.has(item.number) &&
    (item.type === "milestoned" || item.type === "demilestoned" || item.type === "closed"));
  const scopeIssueNumbers = new Set(allIssues.filter((item) => matchesIssuePersonRole(item, query, ["author"])).map((item) => item.number));
  const milestoneSelectionWarnings: AnalyticsWarning[] = missingSelectedMilestone
    ? [{ code: "unknown-milestone-filter", message: `Milestone ${query.milestone} is not present in the loaded milestone records; historical events were not matched as a wildcard.`, excluded: allEvents.length, source: "milestones" }]
    : [];
  const milestoneState = coverage(dataset.coverage, ["milestone"], true, true);
  const issueState = coverage(dataset.coverage, ["issue"], true, true);
  const pullState = coverage(dataset.coverage, ["pull"], true, true);
  const eventState = coverage(dataset.coverage, ["issue-events"], allEvents.length > 0);
  const dependencyState = coverage(dataset.coverage, ["dependenc", "block"], allIssues.some((item) => item.blockedBy.length > 0));
  const eventWarnings = coverageWarnings(dataset.coverage, ["issue-events"], eventState);
  const dependencyWarnings = coverageWarnings(dataset.coverage, ["dependenc", "block"], dependencyState);
  const openMilestones = milestones.filter((item) => item.state === "open");
  const closedMilestones = milestones.filter((item) => item.state === "closed");
  const overdue = openMilestones.filter((item) => item.dueOn !== null && Date.parse(item.dueOn) < now.getTime());
  const openIssues = issues.filter((item) => item.state === "open");
  const closedIssues = issues.filter((item) => item.state === "closed");
  const mergedPulls = pulls.filter((item) => item.mergedAt !== null);
  const blockedStatus = openIssues.filter((item) => item.status === "BLOCKED");
  const openIssueNumbers = new Set(allIssues.filter((item) => item.state === "open").map((item) => item.number));
  const dependencyBlocked = openIssues.filter((item) => item.blockedBy.some((number) => openIssueNumbers.has(number)));
  const buckets = analyticsBuckets(period, now);
  const replayEvents = missingSelectedMilestone
    ? []
    : allEvents
      .map((event) => ({ event, at: Date.parse(event.createdAt) }))
      .filter((item) => Number.isFinite(item.at))
      .sort((left, right) => left.at - right.at || left.event.id.localeCompare(right.event.id));
  const active = new Map<number, AnalyticsEvent>();
  const selectedActive = new Map<number, AnalyticsEvent>();
  const replayedMembership: AnalyticsEvent[] = [];
  const qualifyingCloses: AnalyticsEvent[] = [];
  const closedIssueNumbers = new Set<number>();
  const qualifyingCloseIds: string[] = [];
  const scopePoints: AnalyticsSeries["points"] = [];
  const closedPoints: AnalyticsSeries["points"] = [];
  let replayIndex = 0;
  for (const bucket of buckets) {
    const boundary = Date.parse(bucket.to) - 1;
    while (replayIndex < replayEvents.length && replayEvents[replayIndex]!.at <= boundary) {
      const event = replayEvents[replayIndex]!.event;
      replayIndex += 1;
      if (event.type === "milestoned") {
        active.set(event.number, event);
        if (selectedTitle === undefined || event.milestoneTitle === selectedTitle) selectedActive.set(event.number, event);
        else selectedActive.delete(event.number);
        replayedMembership.push(event);
      } else if (event.type === "demilestoned") {
        if (event.milestoneTitle === null || active.get(event.number)?.milestoneTitle === event.milestoneTitle) {
          active.delete(event.number);
          selectedActive.delete(event.number);
        }
        replayedMembership.push(event);
      } else if (
        matchesIssueEventPersonRole(issuesByNumber.get(event.number)!, event, query, ["author", "actor"]) &&
        selectedActive.has(event.number)
      ) {
        qualifyingCloses.push(event);
        closedIssueNumbers.add(event.number);
        qualifyingCloseIds.push(event.id);
      }
    }
    const activeEvents = [...selectedActive].filter(([number]) => scopeIssueNumbers.has(number)).map(([, event]) => event);
    scopePoints.push(point(bucket.key, bucket.label, activeEvents.length, "issue-event", activeEvents.map((event) => event.id)));
    closedPoints.push(point(bucket.key, bucket.label, closedIssueNumbers.size, "issue-event", qualifyingCloseIds));
  }
  const scopeMembership = replayedMembership.filter((event) => scopeIssueNumbers.has(event.number));
  const historyState = missingSelectedMilestone ? worst(eventState, "unsupported") : eventState;
  const historyWarnings = unique([...eventWarnings, ...milestoneSelectionWarnings], (item) => `${item.code}:${item.source}`);
  const current = (id: string, label: string, records: Array<{ id?: number; number?: number }>, state: AnalyticsCoverageState, kind: AnalyticsDetailRef["kind"], calculation: string) => metric({ id, label, value: records.length, unit: id.includes("milestones.current") && !id.includes("progress") && !id.includes("remaining") ? "count" : "issues", kind: "current", sample: records.length, coverage: state, detailKind: kind, ids: records.map((item) => String(item.id ?? item.number)), calculation, basis: "current-fields" }, computedAt);
  const progress = (id: string, label: string, numerator: number, denominator: number, state: AnalyticsCoverageState, kind: "issue" | "pull-request", ids: string[]) => {
    const populationComplete = state === "complete";
    return metric({ id, label, value: populationComplete && denominator > 0 ? numerator / denominator * 100 : null, unit: "percent", kind: "current", sample: denominator, numerator: populationComplete ? numerator : null, denominator: populationComplete ? denominator : null, coverage: state, detailKind: kind, ids, calculation: !populationComplete ? "Loaded members are not a complete population, so numerator, denominator, and percentage are unavailable." : denominator === 0 ? "Empty milestone is 0 of 0; percentage is unavailable, not 100%." : `${numerator} completed current members divided by ${denominator} members.`, basis: "current-fields", warnings: coverageWarnings(dataset.coverage, [kind === "issue" ? "issue" : "pull"], state) }, computedAt);
  };
  const dependencyMetricState = dependencyState === "complete" ? issueState : worst(issueState, "partial");
  const dependencyMetricWarnings = dependencyState === "complete" ? [] : dependencyWarnings;
  const inScopeAssignees = (issue: AnalyticsIssue) => {
    const includeEveryAssignee = query.person === null ||
      query.role === "author" ||
      (query.role === null && matchesPerson(issue.author, query.person!));
    return issue.assignees.filter((person) =>
      botAllowed(person, query) && (includeEveryAssignee || matchesPerson(person, query.person!)));
  };
  const metrics = [
    current("milestones.current.open", "Open milestones", openMilestones, milestoneState, "milestone", "Current milestones with GitHub state open."),
    current("milestones.current.closed", "Closed milestones", closedMilestones, milestoneState, "milestone", "Current milestones with GitHub state closed; child completion is not inferred."),
    current("milestones.current.overdue", "Overdue milestones", overdue, milestoneState, "milestone", "Open milestones with due_on before calculation time; missing due dates excluded."),
    progress("milestones.current.issue_progress", "Issue progress", closedIssues.length, issues.length, issueState, "issue", issues.map((item) => String(item.id))),
    progress("milestones.current.pr_progress", "PR progress", mergedPulls.length, pulls.length, pullState, "pull-request", pulls.map((item) => String(item.id))),
    metric({ id: "milestones.current.remaining_assignment", label: "Remaining ownership", value: openIssues.reduce((sum, item) => sum + Math.max(1, inScopeAssignees(item).length), 0), unit: "issues", kind: "current", sample: openIssues.length, coverage: issueState, detailKind: "issue", ids: openIssues.map((item) => String(item.id)), calculation: "Open milestone issues count once per in-scope assignee, or Unassigned.", basis: "current-fields" }, computedAt),
    metric({ id: "milestones.current.remaining_blocked", label: "Remaining blocked work", value: new Set([...blockedStatus, ...dependencyBlocked].map((item) => item.id)).size, unit: "issues", kind: "current", sample: openIssues.length, coverage: dependencyMetricState, detailKind: "issue", ids: [...blockedStatus, ...dependencyBlocked].map((item) => String(item.id)), calculation: "Distinct open milestone issues with BLOCKED status or an observed currently open native blocker; incomplete dependency evidence makes the value partial.", basis: "current-fields", warnings: dependencyMetricWarnings }, computedAt),
    metric({ id: "milestones.history.scope", label: "Known scope history", value: scopePoints.at(-1)?.value ?? 0, unit: "issues", kind: "historical", period, sample: scopeMembership.length, coverage: historyState, detailKind: "issue-event", ids: scopeMembership.map((item) => item.id), calculation: "Named milestone membership events replayed at bucket boundaries; assigning milestone B implicitly ends membership in A.", basis: "event-time", warnings: historyWarnings }, computedAt),
    metric({ id: "milestones.history.burnup", label: "Known-history burnup", value: closedPoints.at(-1)?.value ?? 0, unit: "issues", kind: "historical", period, sample: qualifyingCloses.length, coverage: historyState, detailKind: "issue-event", ids: qualifyingCloses.map((item) => item.id), calculation: "Closing events counted only when the selected named milestone was active at the close event time.", basis: "event-time", warnings: historyWarnings }, computedAt),
  ];
  const milestoneAssignees = new Map<string, { label: string; issues: AnalyticsIssue[] }>();
  for (const issue of openIssues) {
    const allowed = inScopeAssignees(issue);
    if (allowed.length === 0) {
      const values = milestoneAssignees.get("unassigned") ?? { label: "Unassigned", issues: [] };
      values.issues.push(issue);
      milestoneAssignees.set("unassigned", values);
    }
    for (const person of allowed) {
      const values = milestoneAssignees.get(person.id) ?? { label: personLabel(person), issues: [] };
      values.issues.push(issue);
      milestoneAssignees.set(person.id, values);
    }
  }
  const rawCharts = [
    chart("milestones.current.progress", "Milestone progress", "Current issue membership split open/closed.", "stacked-bar", "issues", [{ id: "open", label: "Open", unit: "issues", points: milestones.map((milestone) => { const values = openIssues.filter((item) => item.milestone?.number === milestone.number); return point(String(milestone.number), milestone.title, values.length, "issue", values.map((item) => String(item.id))); }) }, { id: "closed", label: "Closed", unit: "issues", points: milestones.map((milestone) => { const values = closedIssues.filter((item) => item.milestone?.number === milestone.number); return point(String(milestone.number), milestone.title, values.length, "issue", values.map((item) => String(item.id))); }) }], issueState),
    chart("milestones.current.pr_progress", "PR progress", "Current PR membership split into open, merged, and closed-unmerged.", "stacked-bar", "pull-requests", [
      { id: "open", label: "Open", unit: "pull-requests", points: milestones.map((milestone) => { const values = pulls.filter((item) => item.milestone?.number === milestone.number && item.state === "open"); return point(String(milestone.number), milestone.title, values.length, "pull-request", values.map((item) => String(item.id))); }) },
      { id: "merged", label: "Merged", unit: "pull-requests", points: milestones.map((milestone) => { const values = pulls.filter((item) => item.milestone?.number === milestone.number && item.mergedAt !== null); return point(String(milestone.number), milestone.title, values.length, "pull-request", values.map((item) => String(item.id))); }) },
      { id: "closed-unmerged", label: "Closed unmerged", unit: "pull-requests", points: milestones.map((milestone) => { const values = pulls.filter((item) => item.milestone?.number === milestone.number && item.state === "closed" && item.mergedAt === null); return point(String(milestone.number), milestone.title, values.length, "pull-request", values.map((item) => String(item.id))); }) },
    ], pullState),
    chart("milestones.current.remaining_assignment", "Remaining ownership", "Open milestone issues count per assignee or Unassigned.", "bar", "issues", [{ id: "issues", label: "Open issues", unit: "issues", points: [...milestoneAssignees].map(([id, values]) => point(id, values.label, new Set(values.issues.map((item) => item.id)).size, "issue", values.issues.map((item) => String(item.id)))) }], issueState),
    chart("milestones.current.remaining_blocked", "Remaining blocked work", "Gitasks BLOCKED status and observed open native dependency signals remain separate.", "bar", "issues", [
      { id: "status", label: "BLOCKED status", unit: "issues", points: [point("blocked", "Blocked", blockedStatus.length, "issue", blockedStatus.map((item) => String(item.id)))] },
      { id: "dependency", label: "Dependency blocked", unit: "issues", points: [point("blocked", "Blocked", dependencyBlocked.length, "issue", dependencyBlocked.map((item) => String(item.id)))] },
    ], dependencyMetricState, dependencyMetricWarnings),
    chart("milestones.history.burnup", "Known-history burnup", "Known scope and closing events while selected membership is active.", "line", "issues", [
      ...(query.person === null || query.role === null || query.role === "author"
        ? [{ id: "scope", label: "Known scope", unit: "issues" as const, points: scopePoints }]
        : []),
      { id: "closed", label: "Closed in known scope", unit: "issues", points: closedPoints },
    ], historyState, historyWarnings),
  ];
  const charts = rawCharts.map((item) => limitChartToRoles(item, query,
    item.id === "milestones.history.burnup"
      ? ["author", "actor"]
      : ["author", "assignee"]));
  const eventRows = allEvents.filter((item) =>
    matchesIssueEventPersonRole(issuesByNumber.get(item.number)!, item, query, ["author", "actor"]));
  const rawTables = [
    table("milestones.records", "Milestones", "GitHub milestone records and current issue counts.", [{ key: "number", label: "Number", numeric: true }, { key: "title", label: "Title" }, { key: "state", label: "State" }, { key: "dueOn", label: "Due" }, { key: "openIssues", label: "Open issues", numeric: true }, { key: "closedIssues", label: "Closed issues", numeric: true }, { key: "url", label: "URL" }], milestones.map((item) => ({ number: item.number, title: item.title, state: item.state, dueOn: item.dueOn, openIssues: issues.filter((issue) => issue.milestone?.number === item.number && issue.state === "open").length, closedIssues: issues.filter((issue) => issue.milestone?.number === item.number && issue.state === "closed").length, url: item.url, _detailKind: "milestone", _detailIds: String(item.number) })), "Current milestone records", milestoneState),
    table("milestones.issue_members", "Milestone issues", "Current issue members with separate status and observed open dependency signals.", [{ key: "number", label: "Issue", numeric: true }, { key: "title", label: "Title" }, { key: "state", label: "State" }, { key: "status", label: "Status" }, { key: "dependencyBlocked", label: "Dependency blocked" }, { key: "assignees", label: "Assignees" }], issues.map((item) => ({ number: item.number, title: item.title, state: item.state, status: item.status ?? "UNCLASSIFIED", dependencyBlocked: dependencyBlocked.some((candidate) => candidate.id === item.id), assignees: item.assignees.map((person) => person.login).join(", ") || "Unassigned", _detailKind: "issue", _detailIds: String(item.id) })), "Current issue milestone membership", issueState),
    table("milestones.events", "Milestone timeline events", "Named membership transfers and close events used for historical scope and burnup.", [{ key: "eventId", label: "Event ID" }, { key: "issue", label: "Issue", numeric: true }, { key: "type", label: "Type" }, { key: "createdAt", label: "Created" }, { key: "actor", label: "Actor" }, { key: "milestone", label: "Milestone" }], eventRows.map((item) => ({ eventId: item.id, issue: item.number, type: item.type, createdAt: item.createdAt, actor: personLabel(item.actor), milestone: item.milestoneTitle, _detailKind: "issue-event", _detailIds: item.id })), "Relevant issue milestone and close timeline events", eventState, eventWarnings),
  ];
  const tables = rawTables.map((item) => limitTableToRoles(item, query,
    item.id === "milestones.issue_members"
      ? ["author", "assignee"]
      : item.id === "milestones.events"
        ? ["author", "actor"]
        : []));
  const milestoneMetricRoles = (id: string): readonly NonNullable<AnalyticsFilters["role"]>[] => {
    if (id === "milestones.current.issue_progress" || id === "milestones.current.remaining_assignment" || id === "milestones.current.remaining_blocked") return ["author", "assignee"];
    if (id === "milestones.current.pr_progress") return ["author", "assignee"];
    if (id === "milestones.history.scope") return ["author"];
    if (id === "milestones.history.burnup") return ["author", "actor"];
    return [];
  };
  const resolvedMetrics = metrics.map((item) => limitMetricToRoles(item, query, milestoneMetricRoles(item.id)));
  const roleWarnings = [...resolvedMetrics, ...charts, ...tables].flatMap((item) => item.warnings).filter((item) => item.code === "filter-role-inapplicable");
  return { section: "milestones", period, filters: query, computedAt, scope: "Selected milestones, current members, and supported membership history", metrics: resolvedMetrics, charts, tables, coverage: dataset.coverage, warnings: unique([...eventWarnings, ...dependencyWarnings, ...milestoneSelectionWarnings, ...roleWarnings, ...incompleteWarning(period)], (item) => `${item.code}:${item.source}`), repository: dataset.repository };
}

function repositoryPayload(dataset: AnalyticsDataset, query: AnalyticsQuery, period: AnalyticsPeriod, computedAt: string): AnalyticsSectionPayload {
  const repository = dataset.repository;
  const languages = unique(repository.languages, (item) => item.name);
  const releases = unique(repository.releases, (item) => String(item.id)).filter((item) => !item.draft && item.publishedAt !== null);
  const periodReleases = releases.filter((item) => instantInPeriod(item.publishedAt, period));
  const tags = unique(repository.tags, (item) => item.name);
  // A supplied GitHub week belongs to the period only when its week-start instant is in [from,to).
  const weeks = unique(repository.commitWeeks, (item) => `${item.source}:${item.week}:${personId(item.author, "unmatched-author")}`)
    .filter((item) => instantInPeriod(item.week, period))
    .filter((item) => item.source !== "contributor" || botAllowed(item.author, query));
  const aggregateWeeks = weeks.filter((item) => item.source === "aggregate");
  const contributorWeeks = weeks.filter((item) => item.source === "contributor" &&
    (query.person === null ||
      (query.role === null || query.role === "author") && matchesPerson(item.author, query.person)));
  const languageState = coverage(dataset.coverage, ["language"], languages.length > 0);
  const releaseState = coverage(dataset.coverage, ["release"], releases.length > 0);
  const tagState = coverage(dataset.coverage, ["tag"], tags.length > 0);
  const commitState = coverage(dataset.coverage, ["commit", "activ"], aggregateWeeks.length > 0);
  const codeState = coverage(dataset.coverage, ["frequency", "code"], aggregateWeeks.some((item) => item.additions !== null || item.deletions !== null));
  const contributorState = coverage(dataset.coverage, ["contributor"], contributorWeeks.length > 0);
  const latest = releases.slice().sort((a, b) => Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!))[0];
  const intervals: Array<{ first: typeof releases[number]; second: typeof releases[number]; days: number; kind: string }> = [];
  for (const prerelease of [false, true]) {
    const values = releases.filter((item) => item.prerelease === prerelease).sort((a, b) => Date.parse(a.publishedAt!) - Date.parse(b.publishedAt!));
    for (let index = 1; index < values.length; index += 1) {
      const first = values[index - 1]!;
      const second = values[index]!;
      intervals.push({ first, second, days: (Date.parse(second.publishedAt!) - Date.parse(first.publishedAt!)) / DAY_MS, kind: prerelease ? "Prerelease" : "Stable" });
    }
  }
  const unavailable = (state: AnalyticsCoverageState, value: number | null) => state === "unsupported" || state === "error" || state === "pending" ? null : value;
  const make = (id: string, label: string, value: number | null, unit: AnalyticsUnit, state: AnalyticsCoverageState, kind: AnalyticsMetric["kind"], detailKind: AnalyticsDetailRef["kind"], ids: string[], calculation: string, sample: number) => metric({ id, label, value: unavailable(state, value), unit, kind, period: kind === "current" ? null : period, sample, coverage: state, detailKind, ids, calculation, basis: "not-applicable", warnings: coverageWarnings(dataset.coverage, id.includes("language") ? ["language"] : id.includes("release") ? ["release"] : id.includes("tag") ? ["tag"] : id.includes("contributor") ? ["contributor"] : id.includes("code") ? ["frequency", "code"] : ["commit", "activ"], state) }, computedAt);
  const metrics = [
    make("repository.current.languages", "Language bytes", languages.reduce((sum, item) => sum + item.bytes, 0), "bytes", languageState, "current", "commit-week", languages.map((item) => item.name), "Current GitHub Linguist byte counts; bytes are not lines or effort.", languages.length),
    make("repository.history.commits", "Commit activity", aggregateWeeks.reduce((sum, item) => sum + item.commits, 0), "count", commitState, "historical", "commit-week", aggregateWeeks.map((item) => `${item.source}:${item.week}`), "Aggregate GitHub weekly default-branch commit counts whose week-start instant is in [from,to); contributor rows are excluded.", aggregateWeeks.length),
    make("repository.history.code_frequency", "Code frequency", aggregateWeeks.reduce((sum, item) => sum + (item.additions ?? 0) + Math.abs(item.deletions ?? 0), 0), "lines", codeState, "historical", "commit-week", aggregateWeeks.map((item) => `${item.source}:${item.week}`), "Aggregate additions plus absolute deletions for week-start instants in [from,to); contributor rows and missing fields are excluded.", aggregateWeeks.filter((item) => item.additions !== null && item.deletions !== null).length),
    make("repository.history.contributors", "Contributor commit activity", new Set(contributorWeeks.map((item) => personId(item.author, "unmatched-author"))).size, "people", contributorState, "historical", "person", contributorWeeks.map((item) => personId(item.author, "unmatched-author")), "Contributor-source rows whose week-start instant is in [from,to), grouped by stable identity; aggregate rows never create an unmatched contributor.", new Set(contributorWeeks.map((item) => personId(item.author, "unmatched-author"))).size),
    make("repository.releases.published", "Published releases", periodReleases.length, "count", releaseState, "period-event", "release", periodReleases.map((item) => String(item.id)), "Published non-draft GitHub releases with published_at in [from,to).", periodReleases.length),
    make("repository.releases.interval", "Release interval", analyticsMedian(intervals.map((item) => item.days)), "days", releaseState, "historical", "release", intervals.flatMap((item) => [String(item.first.id), String(item.second.id)]), "Median adjacent interval after separately sequencing stable and prerelease releases.", intervals.length),
    make("repository.current.latest_release", "Latest release", latest === undefined ? 0 : 1, "count", releaseState, "current", "release", latest === undefined ? [] : [String(latest.id)], "Most recently published non-draft GitHub release; zero says only that no release was supplied.", latest === undefined ? 0 : 1),
    make("repository.current.tags", "Git tags", tags.length, "count", tagState, "current", "release", tags.map((item) => item.name), "Current unique Git tag names and commit SHAs; tags are not releases.", tags.length),
  ];
  const contributorGroups = new Map<string, typeof contributorWeeks>();
  for (const week of contributorWeeks) {
    const id = personId(week.author, "unmatched-author");
    const values = contributorGroups.get(id) ?? [];
    values.push(week);
    contributorGroups.set(id, values);
  }
  const rawCharts = [
    chart("repository.current.languages", "Languages", "Current GitHub Linguist bytes.", "bar", "bytes", [{ id: "bytes", label: "Bytes", unit: "bytes", points: languages.map((item) => point(item.name, item.name, item.bytes, "commit-week", [item.name])) }], languageState),
    chart("repository.history.commits", "Commit activity", "Aggregate weekly default-branch commit counts selected by week-start instant.", "line", "count", [{ id: "commits", label: "Commits", unit: "count", points: aggregateWeeks.map((item) => point(`${item.source}:${item.week}`, item.week, item.commits, "commit-week", [`${item.source}:${item.week}`])) }], commitState),
    chart("repository.history.code_frequency", "Code frequency", "Aggregate weekly additions and absolute deletions selected by week-start instant.", "bar", "lines", [{ id: "additions", label: "Additions", unit: "lines", points: aggregateWeeks.filter((item) => item.additions !== null).map((item) => point(`${item.source}:${item.week}`, item.week, item.additions!, "commit-week", [`${item.source}:${item.week}`])) }, { id: "deletions", label: "Deletions", unit: "lines", points: aggregateWeeks.filter((item) => item.deletions !== null).map((item) => point(`${item.source}:${item.week}`, item.week, Math.abs(item.deletions!), "commit-week", [`${item.source}:${item.week}`])) }], codeState),
    chart("repository.history.contributors", "Contributor activity", "Contributor-source commit counts in selected weeks, grouped by stable GitHub identity.", "bar", "count", [{ id: "commits", label: "Commits", unit: "count", points: [...contributorGroups].map(([id, values]) => point(id, personLabel(values[0]?.author ?? null, "Unmatched author"), values.reduce((sum, item) => sum + item.commits, 0), "person", [id])) }], contributorState, coverageWarnings(dataset.coverage, ["contributor"], contributorState)),
    chart("repository.releases.published", "Published releases", "Published non-draft releases in the selected period.", "bar", "count", [{ id: "releases", label: "Releases", unit: "count", points: periodReleases.map((item) => point(String(item.id), item.tagName, 1, "release", [String(item.id)])) }], releaseState, coverageWarnings(dataset.coverage, ["release"], releaseState)),
    chart("repository.releases.interval", "Release intervals", "Adjacent stable and prerelease intervals remain separately labeled.", "distribution", "days", [{ id: "days", label: "Days", unit: "days", points: intervals.map((item) => point(`${item.first.id}:${item.second.id}`, `${item.first.tagName} → ${item.second.tagName} (${item.kind})`, item.days, "release", [String(item.first.id), String(item.second.id)])) }], releaseState),
  ];
  const charts = rawCharts.map((item) => limitChartToRoles(item, query,
    item.id === "repository.history.contributors" ? ["author"] : []));
  const tableWeeks = query.person === null ? weeks : contributorWeeks;
  const tableWeekState = query.person === null ? worst(commitState, contributorState) : contributorState;
  const rawTables = [
    table("repository.languages", "Languages", "Current GitHub Linguist byte counts.", [{ key: "language", label: "Language" }, { key: "bytes", label: "Bytes", numeric: true }], languages.map((item) => ({ language: item.name, bytes: item.bytes, _detailKind: "commit-week", _detailIds: item.name })), "Repository only", languageState),
    table("repository.commit_weeks", "Commit weeks", "Aggregate and contributor weekly values whose supplied week-start instant is in [from,to).", [{ key: "week", label: "Week" }, { key: "source", label: "Source" }, { key: "author", label: "Contributor" }, { key: "commits", label: "Commits", numeric: true }, { key: "additions", label: "Additions", numeric: true }, { key: "deletions", label: "Deletions", numeric: true }], tableWeeks.map((item) => ({ week: item.week, source: item.source, author: personLabel(item.author, "Unmatched author"), commits: item.commits, additions: item.additions, deletions: item.deletions, _detailKind: "commit-week", _detailIds: `${item.source}:${item.week}:${personId(item.author, "unmatched-author")}` })), "Selected GitHub week-start instants", tableWeekState),
    table("repository.releases", "Releases", "Published non-draft GitHub releases.", [{ key: "tag", label: "Tag" }, { key: "name", label: "Name" }, { key: "kind", label: "Kind" }, { key: "publishedAt", label: "Published" }, { key: "author", label: "Author" }, { key: "url", label: "URL" }], releases.map((item) => ({ tag: item.tagName, name: item.name, kind: item.prerelease ? "Prerelease" : "Stable", publishedAt: item.publishedAt, author: personLabel(item.author), url: item.url, _detailKind: "release", _detailIds: String(item.id) })), "All supplied published non-draft releases", releaseState),
    table("repository.tags", "Tags", "Current tags; ordinary tags are not inferred as releases.", [{ key: "name", label: "Tag" }, { key: "commitSha", label: "Commit SHA" }, { key: "url", label: "URL" }], tags.map((item) => ({ name: item.name, commitSha: item.commitSha, url: item.url, _detailKind: "release", _detailIds: item.name })), "Current repository tags", tagState),
  ];
  const tables = rawTables.map((item) => limitTableToRoles(item, query,
    item.id === "repository.commit_weeks" ? ["author"] : []));
  const resolvedMetrics = metrics.map((item) => limitMetricToRoles(item, query, item.id === "repository.history.contributors" ? ["author"] : []));
  const roleWarnings = [...resolvedMetrics, ...charts, ...tables].flatMap((item) => item.warnings).filter((item) => item.code === "filter-role-inapplicable");
  return { section: "repository", period, filters: query, computedAt, scope: "Repository-only metadata and supported GitHub statistics", metrics: resolvedMetrics, charts, tables, coverage: dataset.coverage, warnings: unique([...resolvedMetrics.flatMap((item) => item.warnings), ...roleWarnings, ...incompleteWarning(period)], (item) => `${item.code}:${item.source}`), repository };
}

function summaryPayload(dataset: AnalyticsDataset, query: AnalyticsQuery, period: AnalyticsPeriod, now: Date, computedAt: string): AnalyticsSectionPayload {
  const unscopedIssueQuery = { ...query, person: null, role: null };
  const issues = unique(dataset.issues, (item) => String(item.id)).filter((item) => matchesIssue(item, unscopedIssueQuery));
  const issuesByNumber = new Map(issues.map((item) => [item.number, item]));
  const issueEvents = unique(dataset.events, (item) => item.id).filter((item) =>
    item.subject === "issue" && issuesByNumber.has(item.number) && botAllowed(item.actor, query));
  const currentIssueRoles = ["author", "assignee"] as const;
  const eventIssueRoles = ["author", "actor"] as const;
  const currentIssues = issues.filter((item) => matchesIssuePersonRole(item, query, currentIssueRoles));
  const historyIssues = issues.filter((item) => matchesIssuePersonRole(item, query, ["author"]));
  const scopedIssueEvents = issueEvents.filter((item) =>
    matchesIssueEventPersonRole(issuesByNumber.get(item.number)!, item, query, eventIssueRoles));
  const eventIssueNumbers = new Set(scopedIssueEvents.map((item) => item.number));
  const recordIssues = query.person === null
    ? issues
    : query.role === "actor"
      ? issues.filter((item) => eventIssueNumbers.has(item.number))
      : query.role === null
        ? issues.filter((item) => matchesIssuePersonRole(item, query, currentIssueRoles) || eventIssueNumbers.has(item.number))
        : currentIssues;
  const openIssues = currentIssues.filter((item) => item.state === "open");
  const openedIssues = historyIssues.filter((item) => instantInPeriod(item.createdAt, period));
  const closedIssueEvents = scopedIssueEvents.filter((item) => item.type === "closed" && instantInPeriod(item.createdAt, period));
  const reopenedIssueEvents = scopedIssueEvents.filter((item) => item.type === "reopened" && instantInPeriod(item.createdAt, period));
  const staleIssues = openIssues.filter((item) => now.getTime() - Date.parse(item.updatedAt) >= query.staleDays * DAY_MS);
  const issueState = coverage(dataset.coverage, ["issue"], true, true);
  const issueEventState = coverage(dataset.coverage, ["issue-events"], issueEvents.length > 0);
  const issueEventWarnings = coverageWarnings(dataset.coverage, ["issue-events"], issueEventState);
  const issueConflicts = statusConflictWarnings(openIssues);
  const issueRecordUsesEvents = query.person !== null && (query.role === null || query.role === "actor");
  const issueRecordState = issueRecordUsesEvents ? worst(issueState, issueEventState) : issueState;
  const issueRecordWarnings = unique([
    ...coverageWarnings(dataset.coverage, ["issue"], issueState),
    ...(issueRecordUsesEvents ? issueEventWarnings : []),
    ...issueConflicts,
  ], (item) => `${item.code}:${item.source}`);
  const closedIssueIds = [...new Set(closedIssueEvents.map((event) => String(issuesByNumber.get(event.number)!.id)))];
  const previousOpened = period.previous === null
    ? null
    : historyIssues.filter((item) => instantInPeriod(item.createdAt, period.previous!)).length;
  const issueMetrics = [
    limitMetricToRoles(metric({ id: "issues.current.open", label: "Open issues", value: openIssues.length, unit: "issues", kind: "current", sample: openIssues.length, coverage: issueState, detailKind: "issue", ids: openIssues.map((item) => String(item.id)), calculation: "Unique currently open non-pull-request issue database IDs.", basis: "current-fields" }, computedAt), query, ["author", "assignee"]),
    limitMetricToRoles(metric({ id: "issues.period.opened_events", label: "Issues opened", value: openedIssues.length, unit: "count", kind: "period-event", period, sample: openedIssues.length, previous: previousOpened, coverage: issueState, detailKind: "issue", ids: openedIssues.map((item) => String(item.id)), calculation: "Issue created_at in [from,to).", basis: "record-fields", warnings: incompleteWarning(period) }, computedAt), query, ["author"]),
    limitMetricToRoles(metric({ id: "issues.period.closed_unique", label: "Issues closed", value: closedIssueIds.length, unit: "issues", kind: "period-event", period, sample: closedIssueIds.length, coverage: issueEventState, detailKind: "issue", ids: closedIssueIds, calculation: "Unique issue database IDs with a closing event in the period.", basis: "event-time", warnings: issueEventWarnings }, computedAt), query, ["author", "actor"]),
    limitMetricToRoles(metric({ id: "issues.current.stale", label: "Stale open issues", value: staleIssues.length, unit: "issues", kind: "current", sample: staleIssues.length, coverage: issueState, detailKind: "issue", ids: staleIssues.map((item) => String(item.id)), calculation: `Open issues with now minus updated_at at least ${query.staleDays} days.`, basis: "current-fields" }, computedAt), query, ["author", "assignee"]),
  ];
  const buckets = analyticsBuckets(period, now);
  const issueCharts = [
    limitChartToRoles(chart("issues.period.activity", "Issue activity", "Opened, closing, and reopening events by local calendar bucket.", "line", "count", [
      { id: "opened", label: "Opened", unit: "count", points: buckets.map((bucket) => { const selected = openedIssues.filter((item) => instantInPeriod(item.createdAt, bucket)); return point(bucket.key, bucket.label, selected.length, "issue", selected.map((item) => String(item.id))); }) },
      { id: "closed", label: "Closed events", unit: "count", points: buckets.map((bucket) => { const selected = closedIssueEvents.filter((item) => instantInPeriod(item.createdAt, bucket)); return point(bucket.key, bucket.label, selected.length, "issue-event", selected.map((item) => item.id)); }) },
      { id: "reopened", label: "Reopened events", unit: "count", points: buckets.map((bucket) => { const selected = reopenedIssueEvents.filter((item) => instantInPeriod(item.createdAt, bucket)); return point(bucket.key, bucket.label, selected.length, "issue-event", selected.map((item) => item.id)); }) },
    ], worst(issueState, issueEventState), issueEventWarnings), query, eventIssueRoles),
    limitChartToRoles(chart("issues.current.status_distribution", "Status distribution", "Current open issues by resolved Gitasks status.", "bar", "issues", [{ id: "issues", label: "Issues", unit: "issues", points: [...TASK_STATUSES, null].map((status) => { const records = openIssues.filter((item) => item.status === status); return point(status ?? "UNCLASSIFIED", status === null ? "Unclassified" : STATUS_NAME[status], records.length, "issue", records.map((item) => String(item.id))); }) }], issueState, issueConflicts), query, currentIssueRoles),
  ];
  const issueTable = limitTableToRoles(table("issues.records", "Issues", "Filtered issue records backing current and period metrics.", [{ key: "number", label: "Number", numeric: true }, { key: "title", label: "Title" }, { key: "state", label: "State" }, { key: "status", label: "Status" }, { key: "author", label: "Author" }, { key: "assignees", label: "Assignees" }, { key: "milestone", label: "Milestone" }, { key: "createdAt", label: "Created" }, { key: "updatedAt", label: "Updated" }, { key: "ageDays", label: "Open age days", numeric: true }, { key: "url", label: "URL" }], recordIssues.map((item) => ({ number: item.number, title: item.title, state: item.state, status: item.status ?? "UNCLASSIFIED", author: personLabel(item.author), assignees: item.assignees.map((person) => person.login).join(", ") || "Unassigned", milestone: item.milestone?.title ?? null, createdAt: item.createdAt, updatedAt: item.updatedAt, ageDays: item.state === "open" ? Math.max(0, (now.getTime() - Date.parse(item.createdAt)) / DAY_MS) : null, url: item.url, _detailKind: "issue", _detailIds: String(item.id) })), "Filtered non-PR issues", issueRecordState, issueRecordWarnings), query, ["author", "assignee", "actor"]);

  const reviews = unique(dataset.reviews, (item) => String(item.id));
  const unscopedPullQuery = { ...query, person: null, role: null };
  const allPulls = unique(dataset.pullRequests, (item) => String(item.id)).filter((item) => matchesPull(item, unscopedPullQuery, reviews));
  const pullEvents = unique(dataset.events, (item) => item.id).filter((item) => item.subject === "pull-request");
  const authorPulls = allPulls.filter((item) => matchesPullPersonRole(item, query, reviews, pullEvents, ["author"]));
  const currentPulls = allPulls.filter((item) => matchesPullPersonRole(item, query, reviews, pullEvents, ["author", "assignee"]));
  const scopedWaitingPulls = allPulls.filter((item) => matchesPullPersonRole(item, query, reviews, pullEvents, ["author", "assignee", "reviewer"]));
  const pulls = allPulls.filter((item) => matchesPullPersonRole(item, query, reviews, pullEvents, ["author", "assignee", "reviewer", "actor"]));
  const openedPulls = authorPulls.filter((item) => instantInPeriod(item.createdAt, period));
  const mergedPulls = authorPulls.filter((item) => instantInPeriod(item.mergedAt, period));
  const closedUnmergedPulls = authorPulls.filter((item) => item.mergedAt === null && instantInPeriod(item.closedAt, period));
  const openPulls = currentPulls.filter((item) => item.state === "open");
  const readyPulls = scopedWaitingPulls.filter((item) => item.state === "open" && !item.draft);
  const reviewerAllowed = (pull: AnalyticsPullRequest, person: AnalyticsPerson) => {
    if (!botAllowed(person, query)) return false;
    if (query.person === null) return true;
    const wholePullMatches = ((query.role === null || query.role === "author") && matchesPerson(pull.author, query.person)) ||
      ((query.role === null || query.role === "assignee") && pull.assignees.some((assignee) => matchesPerson(assignee, query.person!)));
    return wholePullMatches || ((query.role === null || query.role === "reviewer") && matchesPerson(person, query.person));
  };
  const teamAllowed = (pull: AnalyticsPullRequest) =>
    query.person === null ||
    ((query.role === null || query.role === "author") && matchesPerson(pull.author, query.person!)) ||
    ((query.role === null || query.role === "assignee") && pull.assignees.some((assignee) => matchesPerson(assignee, query.person!)));
  const waitingPulls = readyPulls.filter((item) =>
    item.requestedReviewers.some((person) => reviewerAllowed(item, person)) ||
    (teamAllowed(item) && (item.requestedTeams.length > 0 || item.reviewState === "review-required")));
  const pullState = coverage(dataset.coverage, ["pull"], true, true);
  const reviewState = coverage(dataset.coverage, ["review"], reviews.length > 0);
  const pullEventState = coverage(dataset.coverage, ["timelines"], pullEvents.length > 0);
  const pullRecordUsesReviews = query.person !== null && (query.role === null || query.role === "reviewer");
  const pullRecordUsesEvents = query.person !== null && (query.role === null || query.role === "actor");
  const pullRecordState = worst(pullState, pullRecordUsesReviews ? reviewState : "complete", pullRecordUsesEvents ? pullEventState : "complete");
  const pullRecordWarnings = unique([
    ...coverageWarnings(dataset.coverage, ["pull"], pullState),
    ...(pullRecordUsesReviews ? coverageWarnings(dataset.coverage, ["review"], reviewState) : []),
    ...(pullRecordUsesEvents ? coverageWarnings(dataset.coverage, ["timelines"], pullEventState) : []),
  ], (item) => `${item.code}:${item.source}`);
  const requestSourceState = coverage(dataset.coverage, ["review-request"], readyPulls.some((item) =>
    item.requestedReviewers.some((person) => reviewerAllowed(item, person)) || (teamAllowed(item) && item.requestedTeams.length > 0)));
  const requestSourceWarnings = coverageWarnings(dataset.coverage, ["review-request"], requestSourceState);
  const teamRequests = readyPulls.filter(teamAllowed).reduce((sum, item) => sum + item.requestedTeams.length, 0);
  const waitingState = worst(pullState, requestSourceState, teamRequests > 0 ? "partial" : "complete");
  const waitingWarnings = teamRequests === 0
    ? requestSourceWarnings
    : [...requestSourceWarnings, { code: "team-review-requests", message: "Team review requests count toward waiting PRs but cannot be attributed to individual reviewers.", excluded: teamRequests, source: "review-requests" }];
  const previousPullCount = (select: (item: AnalyticsPullRequest) => string | null) =>
    period.previous === null ? null : authorPulls.filter((item) => instantInPeriod(select(item), period.previous!)).length;
  const pullMetrics = [
    limitMetricToRoles(metric({ id: "prs.period.opened", label: "PRs opened", value: openedPulls.length, unit: "pull-requests", kind: "period-event", period, sample: openedPulls.length, previous: previousPullCount((item) => item.createdAt), coverage: pullState, detailKind: "pull-request", ids: openedPulls.map((item) => String(item.id)), calculation: "Unique PRs with created_at in [from,to).", basis: "record-fields", warnings: incompleteWarning(period) }, computedAt), query, ["author"]),
    limitMetricToRoles(metric({ id: "prs.period.merged", label: "PRs merged", value: mergedPulls.length, unit: "pull-requests", kind: "period-event", period, sample: mergedPulls.length, previous: previousPullCount((item) => item.mergedAt), coverage: pullState, detailKind: "pull-request", ids: mergedPulls.map((item) => String(item.id)), calculation: "Unique PRs with merged_at in [from,to); attribution remains PR author.", basis: "record-fields", warnings: incompleteWarning(period) }, computedAt), query, ["author"]),
    limitMetricToRoles(metric({ id: "prs.current.review_waiting", label: "Review waiting", value: waitingPulls.length, unit: "pull-requests", kind: "current", sample: waitingPulls.length, coverage: waitingState, detailKind: "pull-request", ids: waitingPulls.map((item) => String(item.id)), calculation: "Open ready PRs with in-scope requested users, requested teams, or review-required state; reviewer filters count only that selected current reviewer and drafts are excluded.", basis: "current-fields", warnings: waitingWarnings }, computedAt), query, ["author", "assignee", "reviewer"]),
  ];
  const pullCharts = [
    limitChartToRoles(chart("prs.period.activity", "Pull request activity", "Opened, merged, and closed-unmerged PRs by local calendar bucket.", "line", "pull-requests", [
      { id: "opened", label: "Opened", unit: "pull-requests", points: buckets.map((bucket) => { const selected = openedPulls.filter((item) => instantInPeriod(item.createdAt, bucket)); return point(bucket.key, bucket.label, selected.length, "pull-request", selected.map((item) => String(item.id))); }) },
      { id: "merged", label: "Merged", unit: "pull-requests", points: buckets.map((bucket) => { const selected = mergedPulls.filter((item) => instantInPeriod(item.mergedAt, bucket)); return point(bucket.key, bucket.label, selected.length, "pull-request", selected.map((item) => String(item.id))); }) },
      { id: "closed-unmerged", label: "Closed unmerged", unit: "pull-requests", points: buckets.map((bucket) => { const selected = closedUnmergedPulls.filter((item) => instantInPeriod(item.closedAt, bucket)); return point(bucket.key, bucket.label, selected.length, "pull-request", selected.map((item) => String(item.id))); }) },
    ], pullState, incompleteWarning(period)), query, ["author"]),
    limitChartToRoles(chart("prs.current.state_distribution", "Open PR state", "Current open PRs split into draft and ready.", "bar", "pull-requests", [{ id: "pulls", label: "Pull requests", unit: "pull-requests", points: [true, false].map((draft) => { const values = openPulls.filter((item) => item.draft === draft); return point(draft ? "draft" : "ready", draft ? "Draft" : "Ready", values.length, "pull-request", values.map((item) => String(item.id))); }) }], pullState), query, ["author", "assignee"]),
  ];
  const pullTable = limitTableToRoles(table("prs.records", "Pull requests", "Filtered pull request records backing current and period metrics.", [{ key: "number", label: "Number", numeric: true }, { key: "title", label: "Title" }, { key: "state", label: "State" }, { key: "draft", label: "Draft" }, { key: "author", label: "Author" }, { key: "mergedAt", label: "Merged" }, { key: "reviewState", label: "Review state" }, { key: "checksState", label: "Checks" }, { key: "url", label: "URL" }], pulls.map((item) => ({ number: item.number, title: item.title, state: item.state, draft: item.draft, author: personLabel(item.author), mergedAt: item.mergedAt, reviewState: item.reviewState, checksState: item.checksState, url: item.url, _detailKind: "pull-request", _detailIds: String(item.id) })), "Filtered pull requests", pullRecordState, pullRecordWarnings), query, ["author", "assignee", "reviewer", "actor"]);

  const milestones = unique(dataset.milestones, (item) => String(item.number)).filter((item) => query.milestone === null || item.number === query.milestone);
  const overdueMilestones = milestones.filter((item) => item.state === "open" && item.dueOn !== null && Date.parse(item.dueOn) < now.getTime());
  const milestoneState = coverage(dataset.coverage, ["milestone"], true, true);
  const milestoneMetric = limitMetricToRoles(metric({ id: "milestones.current.overdue", label: "Overdue milestones", value: overdueMilestones.length, unit: "count", kind: "current", sample: overdueMilestones.length, coverage: milestoneState, detailKind: "milestone", ids: overdueMilestones.map((item) => String(item.number)), calculation: "Open milestones with due_on before calculation time; missing due dates excluded.", basis: "current-fields" }, computedAt), query, []);

  const releases = unique(dataset.repository.releases, (item) => String(item.id)).filter((item) => !item.draft && item.publishedAt !== null);
  const periodReleases = releases.filter((item) => instantInPeriod(item.publishedAt, period));
  const releaseState = coverage(dataset.coverage, ["release"], releases.length > 0);
  const releaseWarnings = coverageWarnings(dataset.coverage, ["release"], releaseState);
  const releaseMetric = limitMetricToRoles(metric({ id: "repository.releases.published", label: "Published releases", value: periodReleases.length, unit: "count", kind: "period-event", period, sample: periodReleases.length, coverage: releaseState, detailKind: "release", ids: periodReleases.map((item) => String(item.id)), calculation: "Published non-draft GitHub releases with published_at in [from,to).", basis: "not-applicable", warnings: releaseWarnings }, computedAt), query, []);

  const metrics = [...issueMetrics, ...pullMetrics, milestoneMetric, releaseMetric];
  const roleWarnings = [...metrics, ...issueCharts, ...pullCharts, issueTable, pullTable]
    .flatMap((item) => item.warnings)
    .filter((item) => item.code === "filter-role-inapplicable");
  return {
    section: "summary", period, filters: query, computedAt, scope: "Repository overview; current cards ignore period bounds",
    metrics,
    charts: [...issueCharts, ...pullCharts],
    tables: [issueTable, pullTable],
    coverage: dataset.coverage,
    warnings: unique([...issueEventWarnings, ...issueConflicts, ...requestSourceWarnings, ...releaseWarnings, ...roleWarnings, ...incompleteWarning(period)], (item) => `${item.code}:${item.source}:${item.message}`),
    repository: dataset.repository,
  };
}

export function buildAnalyticsSection(dataset: AnalyticsDataset, query: AnalyticsQuery, now = new Date()): AnalyticsSectionPayload {
  const period = buildAnalyticsPeriod(query, now);
  const computedAt = now.toISOString();
  switch (query.section) {
    case "summary": return summaryPayload(dataset, query, period, now, computedAt);
    case "issues": return issuePayload(dataset, query, period, now, computedAt);
    case "pull-requests": return pullPayload(dataset, query, period, now, computedAt);
    case "contributors": return contributorPayload(dataset, query, period, now, computedAt);
    case "milestones": return milestonePayload(dataset, query, period, now, computedAt);
    case "repository": return repositoryPayload(dataset, query, period, computedAt);
  }
}

export function buildAnalyticsBootstrap(dataset: AnalyticsDataset, query: AnalyticsQuery, now = new Date()): AnalyticsBootstrapPayload {
  const people = new Map<string, AnalyticsPerson>();
  const add = (person: AnalyticsPerson | null) => {
    if (person !== null && (query.includeBots || !person.bot)) people.set(person.id, person);
  };
  for (const issue of dataset.issues) {
    add(issue.author);
    for (const assignee of issue.assignees) add(assignee);
  }
  for (const pull of dataset.pullRequests) {
    add(pull.author);
    for (const assignee of pull.assignees) add(assignee);
    for (const reviewer of pull.requestedReviewers) add(reviewer);
  }
  for (const review of dataset.reviews) add(review.reviewer);
  for (const event of dataset.events) {
    add(event.actor);
    add(event.assignee);
    add(event.reviewer);
  }
  const labels = new Set<string>();
  for (const issue of dataset.issues) for (const label of issue.labels) labels.add(label);
  for (const pull of dataset.pullRequests) for (const label of pull.labels) labels.add(label);
  const defaults: AnalyticsQuery = { ...query, section: "summary" };
  return {
    repository: dataset.repository.name,
    computedAt: now.toISOString(),
    defaults,
    options: {
      milestones: unique(dataset.milestones, (item) => String(item.number)).map((item) => ({ number: item.number, title: item.title })).sort((a, b) => a.number - b.number),
      labels: [...labels].sort((a, b) => a.localeCompare(b)),
      people: [...people.values()].sort((a, b) => a.login.localeCompare(b.login)),
      timezones: [...new Set(["UTC", query.timezone, "America/New_York", "Europe/London", "Europe/Istanbul", "Asia/Tokyo"])],
    },
    current: buildAnalyticsSection(dataset, defaults, now),
  };
}
