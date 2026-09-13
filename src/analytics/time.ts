import { UserError } from "../utils/errors.js";
import type {
  AnalyticsGrouping,
  AnalyticsPeriod,
  AnalyticsQuery,
  AnalyticsRole,
  AnalyticsSection,
} from "./types.js";

export interface AnalyticsBucket {
  key: string;
  label: string;
  from: string;
  to: string;
  incomplete: boolean;
}

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const GROUPINGS: Record<AnalyticsGrouping, true> = { day: true, week: true, month: true };
const ROLES: Record<AnalyticsRole, true> = { author: true, assignee: true, reviewer: true, actor: true };
const RANGES: Record<string, true> = { "7": true, "30": true, "90": true, custom: true };
// Hard limit for calendar buckets materialized by one analytics query.
export const MAX_ANALYTICS_BUCKETS = 4_000;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let value = formatterCache.get(timezone);
  if (value === undefined) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timezone, value);
  }
  return value;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    formatter(timezone).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function localParts(instant: Date, timezone: string): CivilDate & { hour: number; minute: number; second: number } {
  const parts: Record<string, number> = Object.fromEntries(
    formatter(timezone)
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

function civilKey(date: CivilDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function parseCivilDate(value: string, name: string): CivilDate {
  const match = DATE_PATTERN.exec(value);
  if (match === null) {
    throw new UserError(`Invalid analytics ${name}: expected YYYY-MM-DD`);
  }
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const check = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (
    check.getUTCFullYear() !== date.year ||
    check.getUTCMonth() !== date.month - 1 ||
    check.getUTCDate() !== date.day
  ) {
    throw new UserError(`Invalid analytics ${name}: ${value}`);
  }
  return date;
}

function addCivilDays(date: CivilDate, days: number): CivilDate {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function addCivilMonths(date: CivilDate, months: number): CivilDate {
  const value = new Date(Date.UTC(date.year, date.month - 1 + months, 1));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: 1 };
}

function civilWeekday(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function analyticsBucketCount(from: CivilDate, to: CivilDate, grouping: AnalyticsGrouping): number {
  if (grouping === "month") {
    return (to.year - from.year) * 12 + to.month - from.month + 1;
  }
  const fromDay = Date.UTC(from.year, from.month - 1, from.day) / 86_400_000;
  const toDay = Date.UTC(to.year, to.month - 1, to.day) / 86_400_000;
  if (grouping === "day") return toDay - fromDay + 1;
  const alignedFrom = fromDay - ((civilWeekday(from) + 6) % 7);
  return Math.floor((toDay - alignedFrom) / 7) + 1;
}

function assertSafeBucketCount(from: CivilDate, to: CivilDate, grouping: AnalyticsGrouping): void {
  const count = analyticsBucketCount(from, to, grouping);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_ANALYTICS_BUCKETS) {
    throw new UserError(`Analytics range would create ${count} ${grouping} buckets; maximum is ${MAX_ANALYTICS_BUCKETS}`);
  }
}

export function zonedDayStart(date: string | CivilDate, timezone: string): Date {
  if (!isValidTimezone(timezone)) {
    throw new UserError(`Invalid analytics timezone: ${timezone}`);
  }
  const civil = typeof date === "string" ? parseCivilDate(date, "date") : date;
  const target = Date.UTC(civil.year, civil.month - 1, civil.day);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = localParts(new Date(guess), timezone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const next = guess + target - represented;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

function oneValue(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);
  if (values.length > 1) throw new UserError(`Analytics parameter '${key}' may be supplied only once`);
  return values[0] ?? null;
}

function booleanValue(value: string | null, fallback: boolean, name: string): boolean {
  if (value === null) return fallback;
  if (value === "true" || value === "1" || value === "include") return true;
  if (value === "false" || value === "0" || value === "exclude") return false;
  throw new UserError(`Invalid analytics ${name}: ${value}`);
}

function positiveInteger(value: string | null, fallback: number, name: string): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new UserError(`Invalid analytics ${name}: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 3650) {
    throw new UserError(`Invalid analytics ${name}: ${value}`);
  }
  return parsed;
}

export function defaultAnalyticsQuery(section: AnalyticsSection, now = new Date()): AnalyticsQuery {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const today = localParts(now, timezone);
  const from = zonedDayStart(addCivilDays(today, -29), timezone);
  const to = zonedDayStart(addCivilDays(today, 1), timezone);
  return {
    section,
    from: from.toISOString(),
    to: to.toISOString(),
    timezone,
    grouping: "day",
    milestone: null,
    labels: [],
    person: null,
    role: null,
    includeBots: false,
    compare: false,
    staleDays: 14,
    reviewWaitDays: 3,
  };
}

export function parseAnalyticsQuery(
  params: URLSearchParams,
  section: AnalyticsSection,
  now = new Date(),
): AnalyticsQuery {
  const timezone = oneValue(params, "timezone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  if (!isValidTimezone(timezone)) throw new UserError(`Invalid analytics timezone: ${timezone}`);

  const range = oneValue(params, "range") ?? "30";
  if (!RANGES[range]) {
    throw new UserError(`Invalid analytics range: ${range}`);
  }
  const groupingValue = oneValue(params, "group") ?? (range === "90" ? "week" : "day");
  if (!GROUPINGS[groupingValue as AnalyticsGrouping]) {
    throw new UserError(`Invalid analytics grouping: ${groupingValue}`);
  }
  const grouping = groupingValue as AnalyticsGrouping;
  const today = localParts(now, timezone);
  let from: Date;
  let to: Date;
  if (range === "custom") {
    const fromValue = oneValue(params, "from");
    const toValue = oneValue(params, "to");
    if (fromValue === null || toValue === null) {
      throw new UserError("Custom analytics ranges require from and to dates");
    }
    const fromDate = parseCivilDate(fromValue, "from");
    const finalDate = parseCivilDate(toValue, "to");
    if (fromDate.year < finalDate.year ||
      fromDate.year === finalDate.year && (fromDate.month < finalDate.month ||
        fromDate.month === finalDate.month && fromDate.day <= finalDate.day)) {
      assertSafeBucketCount(fromDate, finalDate, grouping);
    }
    from = zonedDayStart(fromDate, timezone);
    to = zonedDayStart(addCivilDays(finalDate, 1), timezone);
  } else {
    if (params.has("from") || params.has("to")) {
      throw new UserError("Analytics from/to parameters require range=custom");
    }
    const days = Number(range);
    from = zonedDayStart(addCivilDays(today, -(days - 1)), timezone);
    to = zonedDayStart(addCivilDays(today, 1), timezone);
  }
  if (from.getTime() >= to.getTime()) throw new UserError("Analytics from must be before to");


  const milestoneValue = oneValue(params, "milestone");
  const milestone = milestoneValue === null ? null : positiveInteger(milestoneValue, 1, "milestone");
  const labels = [...new Set(params.getAll("label").map((label) => label.trim()).filter(Boolean))];
  const person = oneValue(params, "person")?.trim() || null;
  const roleValue = oneValue(params, "role");
  if (roleValue !== null && !ROLES[roleValue as AnalyticsRole]) {
    throw new UserError(`Invalid analytics role: ${roleValue}`);
  }

  return {
    section,
    from: from.toISOString(),
    to: to.toISOString(),
    timezone,
    grouping,
    milestone,
    labels,
    person,
    role: roleValue as AnalyticsRole | null,
    includeBots: booleanValue(oneValue(params, "bots"), false, "bots"),
    compare: booleanValue(oneValue(params, "compare"), false, "compare"),
    staleDays: positiveInteger(oneValue(params, "staleDays"), 14, "staleDays"),
    reviewWaitDays: positiveInteger(oneValue(params, "reviewWaitDays"), 3, "reviewWaitDays"),
  };
}

export function buildAnalyticsPeriod(query: AnalyticsQuery, now = new Date()): AnalyticsPeriod {
  const from = new Date(query.from);
  const to = new Date(query.to);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    throw new UserError("Invalid analytics period boundaries");
  }
  if (!isValidTimezone(query.timezone)) throw new UserError(`Invalid analytics timezone: ${query.timezone}`);
  const currentDayStart = zonedDayStart(localParts(now, query.timezone), query.timezone);
  const incomplete = to.getTime() > currentDayStart.getTime();
  const duration = to.getTime() - from.getTime();
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    timezone: query.timezone,
    grouping: query.grouping,
    incomplete,
    previous: query.compare
      ? { from: new Date(from.getTime() - duration).toISOString(), to: from.toISOString() }
      : null,
  };
}

export function analyticsBuckets(period: AnalyticsPeriod, now = new Date()): AnalyticsBucket[] {
  const periodFrom = new Date(period.from);
  const periodTo = new Date(period.to);
  if (!Number.isFinite(periodFrom.getTime()) || !Number.isFinite(periodTo.getTime()) || periodFrom >= periodTo) {
    throw new UserError("Invalid analytics period boundaries");
  }
  const firstCivil = localParts(periodFrom, period.timezone);
  const finalCivil = localParts(new Date(periodTo.getTime() - 1), period.timezone);
  assertSafeBucketCount(firstCivil, finalCivil, period.grouping);
  let civil: CivilDate = localParts(periodFrom, period.timezone);
  if (period.grouping === "week") {
    civil = addCivilDays(civil, -((civilWeekday(civil) + 6) % 7));
  } else if (period.grouping === "month") {
    civil = { ...civil, day: 1 };
  }

  const buckets: AnalyticsBucket[] = [];
  while (true) {
    const rawFrom = zonedDayStart(civil, period.timezone);
    const nextCivil = period.grouping === "day"
      ? addCivilDays(civil, 1)
      : period.grouping === "week"
        ? addCivilDays(civil, 7)
        : addCivilMonths(civil, 1);
    const rawTo = zonedDayStart(nextCivil, period.timezone);
    if (rawFrom >= periodTo) break;
    const from = new Date(Math.max(rawFrom.getTime(), periodFrom.getTime()));
    const to = new Date(Math.min(rawTo.getTime(), periodTo.getTime()));
    if (to > periodFrom) {
      const key = civilKey(civil);
      const label = period.grouping === "day"
        ? key
        : period.grouping === "week"
          ? `Week of ${key}`
          : key.slice(0, 7);
      buckets.push({
        key,
        label,
        from: from.toISOString(),
        to: to.toISOString(),
        incomplete: to.getTime() > now.getTime() || period.incomplete && to.getTime() === periodTo.getTime(),
      });
    }
    civil = nextCivil;
  }
  return buckets;
}

export function instantInPeriod(value: string | null, period: Pick<AnalyticsPeriod, "from" | "to">): boolean {
  if (value === null) return false;
  const instant = Date.parse(value);
  return Number.isFinite(instant) && instant >= Date.parse(period.from) && instant < Date.parse(period.to);
}
