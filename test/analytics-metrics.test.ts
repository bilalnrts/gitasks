import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { analyticsTableCsv } from "../src/analytics/csv.js";
import { analyticsMedian, analyticsP75, buildAnalyticsBootstrap, buildAnalyticsSection } from "../src/analytics/compute.js";
import { MAX_ANALYTICS_BUCKETS, analyticsBuckets, buildAnalyticsPeriod, parseAnalyticsQuery } from "../src/analytics/time.js";
import type {
  AnalyticsCoverageSource,
  AnalyticsDataset,
  AnalyticsEvent,
  AnalyticsIssue,
  AnalyticsPerson,
  AnalyticsPullRequest,
  AnalyticsQuery,
  AnalyticsSectionPayload,
} from "../src/analytics/types.js";

const NOW = new Date("2026-04-01T12:00:00.000Z");

const human: AnalyticsPerson = { id: "user:1", login: "alice", displayName: "Alice", avatarUrl: null, url: "https://github.com/alice", bot: false, deleted: false };
const reviewer: AnalyticsPerson = { id: "user:2", login: "bob", displayName: "Bob", avatarUrl: null, url: "https://github.com/bob", bot: false, deleted: false };
const bot: AnalyticsPerson = { id: "user:3", login: "helper[bot]", displayName: "Helper", avatarUrl: null, url: "https://github.com/apps/helper", bot: true, deleted: false };

function source(id: string, state: AnalyticsCoverageSource["state"] = "complete"): AnalyticsCoverageSource {
  return { id, label: id, state, loaded: 1, knownTotal: 1, from: "2026-01-01T00:00:00.000Z", to: "2026-04-01T00:00:00.000Z", fetchedAt: NOW.toISOString(), excluded: 0, reason: state === "complete" ? null : `${id} unavailable`, limitations: [] };
}

function issue(values: Partial<AnalyticsIssue> & Pick<AnalyticsIssue, "id" | "number">): AnalyticsIssue {
  const title = values.title ?? `Issue ${values.number}`;
  const status = values.status === undefined ? "TODO" : values.status;
  const suppliedLabels = values.labels ?? [];
  const statusLabels = values.statusLabels ?? (values.labels === undefined && status !== null
    ? [`status:${status.toLowerCase().replaceAll(" ", "-")}`]
    : suppliedLabels.filter((label) => label.toLowerCase().startsWith("status:")));
  return {
    id: values.id,
    nodeId: `I_${values.id}`,
    number: values.number,
    title,
    fullTitle: values.fullTitle ?? (status === null ? title : `[${status}] ${title}`),
    state: values.state ?? "open",
    stateReason: values.stateReason ?? "unknown",
    status,
    labels: suppliedLabels.filter((label) => !label.toLowerCase().startsWith("status:")),
    statusLabels,
    author: values.author === undefined ? human : values.author,
    assignees: values.assignees ?? [],
    milestone: values.milestone === undefined ? milestone : values.milestone,
    createdAt: values.createdAt ?? "2026-03-01T12:00:00.000Z",
    updatedAt: values.updatedAt ?? "2026-03-31T12:00:00.000Z",
    closedAt: values.closedAt ?? null,
    url: values.url ?? `https://github.com/acme/example/issues/${values.number}`,
    blockedBy: values.blockedBy ?? [],
    blocking: values.blocking ?? [],
  };
}

function pull(values: Partial<AnalyticsPullRequest> & Pick<AnalyticsPullRequest, "id" | "number">): AnalyticsPullRequest {
  return {
    id: values.id,
    nodeId: `PR_${values.id}`,
    number: values.number,
    title: values.title ?? `PR ${values.number}`,
    state: values.state ?? "open",
    draft: values.draft ?? false,
    mergedAt: values.mergedAt ?? null,
    closedAt: values.closedAt ?? null,
    createdAt: values.createdAt ?? "2026-03-01T00:00:00.000Z",
    updatedAt: values.updatedAt ?? "2026-03-20T00:00:00.000Z",
    author: values.author === undefined ? human : values.author,
    assignees: values.assignees ?? [],
    requestedReviewers: values.requestedReviewers ?? [],
    requestedTeams: values.requestedTeams ?? [],
    milestone: values.milestone === undefined ? milestone : values.milestone,
    labels: values.labels ?? ["feature"],
    reviewState: values.reviewState ?? "unknown",
    checksState: values.checksState ?? "unknown",
    headSha: values.headSha ?? String(values.id).padStart(40, "0"),
    changedFiles: values.changedFiles === undefined ? 2 : values.changedFiles,
    additions: values.additions === undefined ? 20 : values.additions,
    deletions: values.deletions === undefined ? 5 : values.deletions,
    url: values.url ?? `https://github.com/acme/example/pull/${values.number}`,
  };
}

const milestone = {
  number: 1,
  title: "0.5",
  description: "Analytics",
  state: "open" as const,
  dueOn: "2026-03-31T00:00:00.000Z",
  openIssues: 3,
  closedIssues: 2,
  url: "https://github.com/acme/example/milestone/1",
  updatedAt: "2026-03-20T00:00:00.000Z",
  createdAt: "2026-02-01T00:00:00.000Z",
  closedAt: null,
};

function event(id: string, number: number, type: AnalyticsEvent["type"], createdAt: string, extras: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return { id, subject: number >= 10 ? "pull-request" : "issue", number, type, createdAt, actor: human, label: null, assignee: null, reviewer: null, milestoneTitle: null, reviewId: null, reviewState: null, rename: null, ...extras };
}

function fixture(): AnalyticsDataset {
  const issues = [
    issue({ id: 101, number: 1, status: "IN PROGRESS", labels: ["status:in-progress", "feature"], assignees: [human, bot], blockedBy: [2], updatedAt: "2026-03-01T12:00:00.000Z" }),
    issue({ id: 102, number: 2, status: "BLOCKED", labels: ["status:blocked"], assignees: [reviewer] }),
    issue({ id: 103, number: 3, state: "closed", status: "TODO", createdAt: "2026-03-01T12:00:00.000Z", closedAt: "2026-03-08T12:00:00.000Z", stateReason: "not_planned" }),
    issue({ id: 104, number: 4, state: "closed", status: "DONE", labels: ["status:done"], createdAt: "2026-03-01T12:00:00.000Z", closedAt: "2026-03-07T12:00:00.000Z", stateReason: "completed", author: null }),
    issue({ id: 105, number: 5, status: "TODO", labels: ["status:todo", "status:blocked"], milestone: null }),
    issue({ id: 106, number: 6, author: bot, milestone: null }),
    issue({ id: 102, number: 2, title: "Duplicate transport page row" }),
  ];
  const pullRequests = [
    pull({ id: 210, number: 10, state: "closed", mergedAt: "2026-03-07T00:00:00.000Z", closedAt: "2026-03-07T00:00:00.000Z", changedFiles: 2, additions: 20, deletions: 5 }),
    pull({ id: 211, number: 11, requestedReviewers: [reviewer], reviewState: "review-required", checksState: "failure", changedFiles: 8, additions: 100, deletions: 20 }),
    pull({ id: 212, number: 12, draft: true, requestedReviewers: [reviewer], reviewState: "review-required", author: bot }),
    pull({ id: 213, number: 13, state: "closed", closedAt: "2026-03-22T00:00:00.000Z", changedFiles: null, additions: null, deletions: null }),
  ];
  const reviews = [
    { id: 301, pullNumber: 10, reviewer, state: "approved" as const, submittedAt: "2026-03-05T00:00:00.000Z", commitId: null, url: "https://github.com/acme/example/pull/10#review-301" },
    { id: 302, pullNumber: 11, reviewer, state: "changes-requested" as const, submittedAt: "2026-03-15T00:00:00.000Z", commitId: null, url: null },
    { id: 303, pullNumber: 11, reviewer, state: "approved" as const, submittedAt: "2026-03-16T00:00:00.000Z", commitId: null, url: null },
    { id: 304, pullNumber: 11, reviewer: human, state: "changes-requested" as const, submittedAt: "2026-03-17T00:00:00.000Z", commitId: null, url: null },
    { id: 305, pullNumber: 11, reviewer, state: "pending" as const, submittedAt: null, commitId: null, url: null },
    { id: 306, pullNumber: 11, reviewer, state: "dismissed" as const, submittedAt: "2026-03-18T00:00:00.000Z", commitId: null, url: null },
    { id: 304, pullNumber: 11, reviewer: human, state: "changes-requested" as const, submittedAt: "2026-03-17T00:00:00.000Z", commitId: null, url: null },
  ];
  const events = [
    event("close-3a", 3, "closed", "2026-03-03T12:00:00.000Z"),
    event("reopen-3", 3, "reopened", "2026-03-04T12:00:00.000Z"),
    event("close-3b", 3, "closed", "2026-03-08T12:00:00.000Z"),
    event("progress-4", 4, "labeled", "2026-03-02T12:00:00.000Z", { label: "status:in-progress" }),
    event("done-4", 4, "labeled", "2026-03-06T12:00:00.000Z", { label: "status:done" }),
    event("close-4", 4, "closed", "2026-03-07T12:00:00.000Z"),
    event("ready-10a", 10, "ready-for-review", "2026-03-02T00:00:00.000Z"),
    event("draft-10", 10, "converted-to-draft", "2026-03-03T00:00:00.000Z"),
    event("ready-10b", 10, "ready-for-review", "2026-03-04T00:00:00.000Z"),
    event("request-11", 11, "review-requested", "2026-03-20T00:00:00.000Z", { reviewer }),
    event("review-301", 10, "review-submitted", "2026-03-05T00:00:00.000Z", { actor: reviewer, reviewer, reviewId: 301, reviewState: "approved" }),
    event("review-302", 11, "review-submitted", "2026-03-15T00:00:00.000Z", { actor: reviewer, reviewer, reviewId: 302, reviewState: "changes-requested" }),
    event("review-303", 11, "review-submitted", "2026-03-16T00:00:00.000Z", { actor: reviewer, reviewer, reviewId: 303, reviewState: "approved" }),
    event("review-304", 11, "review-submitted", "2026-03-17T00:00:00.000Z", { reviewer: human, reviewId: 304, reviewState: "changes-requested" }),
    event("member-1", 1, "milestoned", "2026-03-02T00:00:00.000Z", { milestoneTitle: "0.5" }),
    event("member-3", 3, "milestoned", "2026-03-02T00:00:00.000Z", { milestoneTitle: "0.5" }),
    event("remove-1", 1, "demilestoned", "2026-03-10T00:00:00.000Z", { milestoneTitle: "0.5" }),
    event("close-3b", 3, "closed", "2026-03-08T12:00:00.000Z"),
  ];
  return {
    repository: {
      name: "acme/example",
      description: "Example",
      visibility: "private",
      defaultBranch: "main",
      license: "MIT",
      url: "https://github.com/acme/example",
      languages: [{ name: "TypeScript", bytes: 900 }, { name: "CSS", bytes: 100 }],
      releases: [
        { id: 401, tagName: "v0.3.0", name: "0.3", draft: false, prerelease: false, createdAt: "2026-01-01T00:00:00.000Z", publishedAt: "2026-01-01T00:00:00.000Z", url: "https://github.com/acme/example/releases/401", author: human },
        { id: 402, tagName: "v0.4.0", name: "0.4", draft: false, prerelease: false, createdAt: "2026-02-01T00:00:00.000Z", publishedAt: "2026-02-01T00:00:00.000Z", url: "https://github.com/acme/example/releases/402", author: human },
        { id: 403, tagName: "v0.5.0-rc.1", name: "0.5 RC", draft: false, prerelease: true, createdAt: "2026-03-20T00:00:00.000Z", publishedAt: "2026-03-20T00:00:00.000Z", url: "https://github.com/acme/example/releases/403", author: bot },
        { id: 404, tagName: "draft", name: "Draft", draft: true, prerelease: false, createdAt: "2026-03-25T00:00:00.000Z", publishedAt: null, url: "https://github.com/acme/example/releases/404", author: human },
      ],
      tags: [{ name: "v0.4.0", commitSha: "a".repeat(40), url: "https://github.com/acme/example/tree/v0.4.0" }, { name: "nightly", commitSha: "b".repeat(40), url: "https://github.com/acme/example/tree/nightly" }],
      commitWeeks: [
        { week: "2026-03-01T00:00:00.000Z", source: "aggregate", commits: 4, additions: 40, deletions: -10, author: null },
        { week: "2026-03-08T00:00:00.000Z", source: "aggregate", commits: 3, additions: 20, deletions: -5, author: null },
        { week: "2026-03-01T00:00:00.000Z", source: "contributor", commits: 4, additions: 400, deletions: -100, author: human },
        { week: "2026-03-08T00:00:00.000Z", source: "contributor", commits: 3, additions: 300, deletions: -50, author: reviewer },
      ],
    },
    issues,
    pullRequests,
    reviews,
    events,
    milestones: [milestone, { ...milestone, number: 2, title: "0.4", state: "closed", dueOn: null, closedAt: "2026-02-01T00:00:00.000Z" }],
    coverage: [source("issues"), source("pulls"), source("reviews"), source("review-requests"), source("issue-events"), source("timelines"), source("dependencies"), source("pull-details"), source("checks"), source("milestones"), source("languages"), source("releases"), source("tags"), source("commit-activity"), source("code-frequency"), source("contributors")],
    fetchedAt: NOW.toISOString(),
  };
}

function query(section: AnalyticsQuery["section"], overrides: Partial<AnalyticsQuery> = {}): AnalyticsQuery {
  return {
    section,
    from: "2026-03-01T00:00:00.000Z",
    to: "2026-04-01T00:00:00.000Z",
    timezone: "UTC",
    grouping: "day",
    milestone: null,
    labels: [],
    person: null,
    role: null,
    includeBots: false,
    compare: true,
    staleDays: 14,
    reviewWaitDays: 3,
    ...overrides,
  };
}

function value(payload: AnalyticsSectionPayload, id: string) {
  const result = payload.metrics.find((item) => item.id === id);
  assert.ok(result, `missing metric ${id}`);
  return result;
}

describe("analytics calendar periods", () => {
  test("turns inclusive local date controls into a DST-aware half-open spring period", () => {
    const parsed = parseAnalyticsQuery(new URLSearchParams("range=custom&from=2026-03-08&to=2026-03-08&timezone=America%2FNew_York&group=day"), "issues", NOW);
    assert.equal(parsed.from, "2026-03-08T05:00:00.000Z");
    assert.equal(parsed.to, "2026-03-09T04:00:00.000Z");
    assert.equal(Date.parse(parsed.to) - Date.parse(parsed.from), 23 * 60 * 60 * 1000);
  });

  test("handles the 25-hour autumn day and exact [from,to) membership", () => {
    const parsed = parseAnalyticsQuery(new URLSearchParams("range=custom&from=2026-11-01&to=2026-11-01&timezone=America%2FNew_York"), "issues", NOW);
    assert.equal(Date.parse(parsed.to) - Date.parse(parsed.from), 25 * 60 * 60 * 1000);
    const period = buildAnalyticsPeriod({ ...parsed, compare: true }, new Date("2026-12-01T00:00:00.000Z"));
    assert.equal(period.incomplete, false);
    assert.equal(Date.parse(period.previous!.to) - Date.parse(period.previous!.from), 25 * 60 * 60 * 1000);
    assert.equal(instantInPeriodForTest(period.from, period), true);
    assert.equal(instantInPeriodForTest(period.to, period), false);
  });

  test("marks a range containing the current local day incomplete and buckets by local weeks", () => {
    const period = buildAnalyticsPeriod(query("issues", { from: "2026-03-01T05:00:00.000Z", to: "2026-03-16T04:00:00.000Z", timezone: "America/New_York", grouping: "week" }), new Date("2026-03-15T16:00:00.000Z"));
    assert.equal(period.incomplete, true);
    const buckets = analyticsBuckets(period, new Date("2026-03-15T16:00:00.000Z"));
    assert.deepEqual(buckets.map((item) => item.key), ["2026-02-23", "2026-03-02", "2026-03-09"]);
    assert.equal(buckets.at(-1)?.incomplete, true);
  });

  test("rejects custom ranges that exceed the fixed bucket materialization limit", () => {
    assert.throws(
      () => parseAnalyticsQuery(new URLSearchParams("range=custom&from=2000-01-01&to=2011-01-01&timezone=UTC&group=day"), "issues", NOW),
      { name: "UserError", message: `Analytics range would create 4019 day buckets; maximum is ${MAX_ANALYTICS_BUCKETS}` },
    );
    const parsed = parseAnalyticsQuery(new URLSearchParams("range=custom&from=2026-03-01&to=2026-03-31&timezone=UTC&group=day"), "issues", NOW);
    assert.equal(analyticsBuckets(buildAnalyticsPeriod(parsed, NOW), NOW).length, 31);
  });

  test("rejects invalid dates, time zones, roles, duplicate scalar filters, and inverted custom dates", () => {
    assert.throws(() => parseAnalyticsQuery(new URLSearchParams("range=custom&from=2026-02-30&to=2026-03-01&timezone=UTC"), "issues"));
    assert.throws(() => parseAnalyticsQuery(new URLSearchParams("timezone=Not%2FAZone"), "issues"));
    assert.throws(() => parseAnalyticsQuery(new URLSearchParams("role=owner"), "issues"));
    assert.throws(() => parseAnalyticsQuery(new URLSearchParams("milestone=1&milestone=2"), "issues"));
    assert.throws(() => parseAnalyticsQuery(new URLSearchParams("range=custom&from=2026-04-01&to=2026-03-01&timezone=UTC"), "issues"));
  });
});

function instantInPeriodForTest(valueToTest: string, period: { from: string; to: string }): boolean {
  const instant = Date.parse(valueToTest);
  return instant >= Date.parse(period.from) && instant < Date.parse(period.to);
}

describe("analytics issue metrics", () => {
  test("keeps close, reopen, and DONE events distinct and uses episode durations", () => {
    const payload = buildAnalyticsSection(fixture(), query("issues"), NOW);
    assert.equal(value(payload, "issues.period.closed_events").value, 3);
    assert.equal(value(payload, "issues.period.closed_unique").value, 2);
    assert.equal(value(payload, "issues.period.reopened_events").value, 1);
    assert.equal(value(payload, "issues.period.reopened_unique").value, 1);
    assert.equal(value(payload, "issues.period.completed_unique").value, 1);
    assert.equal(value(payload, "issues.period.closed_not_completed").value, 1);
    assert.equal(value(payload, "issues.duration.close.median").value, 4);
    assert.equal(value(payload, "issues.duration.close.p75").value, 6);
    assert.equal(value(payload, "issues.duration.cycle.median").value, 4);
    assert.deepEqual(value(payload, "issues.period.closed_events").detail.ids, ["close-3a", "close-3b", "close-4"]);
  });

  test("cohorts completed cycles by the period and clips spanning status intervals", () => {
    const data = fixture();
    data.issues = [
      issue({ id: 101, number: 1, status: "DONE", statusLabels: ["status:done"], createdAt: "2026-01-20T00:00:00.000Z" }),
      issue({ id: 102, number: 2, status: "DONE", statusLabels: ["status:done"], createdAt: "2026-02-20T00:00:00.000Z" }),
    ];
    data.events = [
      event("old-progress", 1, "labeled", "2026-02-01T00:00:00.000Z", { label: "status:in-progress" }),
      event("old-done", 1, "labeled", "2026-02-05T00:00:00.000Z", { label: "status:done" }),
      event("spanning-progress", 2, "labeled", "2026-02-25T00:00:00.000Z", { label: "status:in-progress" }),
      event("a-spanning-unlabeled", 2, "unlabeled", "2026-03-10T00:00:00.000Z", { label: "status:in-progress" }),
      event("b-spanning-done", 2, "labeled", "2026-03-10T00:00:00.000Z", { label: "status:done" }),
    ];
    const payload = buildAnalyticsSection(data, query("issues"), NOW);
    assert.equal(value(payload, "issues.duration.cycle.median").value, 13);
    assert.deepEqual(value(payload, "issues.duration.cycle.median").detail.ids, ["spanning-progress", "a-spanning-unlabeled", "b-spanning-done"]);
    const statusChart = payload.charts.find((item) => item.id === "issues.history.status_time");
    assert.ok(statusChart);
    const inProgress = statusChart.series[0]?.points.find((item) => item.key === "IN PROGRESS");
    assert.equal(inProgress?.value, 9);
    assert.deepEqual(inProgress?.detail.ids, ["spanning-progress", "a-spanning-unlabeled"]);
  });

  test("measures verified cycles through intermediate statuses until DONE", () => {
    const data = fixture();
    data.issues = [issue({ id: 101, number: 1, status: "DONE", statusLabels: ["status:done"] })];
    data.events = [
      event("cycle-progress", 1, "renamed", "2026-03-02T00:00:00.000Z", { rename: { from: "[TODO] Issue 1", to: "[IN PROGRESS] Issue 1" } }),
      event("cycle-review", 1, "renamed", "2026-03-05T00:00:00.000Z", { rename: { from: "[IN PROGRESS] Issue 1", to: "[REVIEW] Issue 1" } }),
      event("cycle-blocked", 1, "renamed", "2026-03-06T00:00:00.000Z", { rename: { from: "[REVIEW] Issue 1", to: "[BLOCKED] Issue 1" } }),
      event("cycle-done", 1, "renamed", "2026-03-09T00:00:00.000Z", { rename: { from: "[BLOCKED] Issue 1", to: "[DONE] Issue 1" } }),
    ];
    const cycle = value(buildAnalyticsSection(data, query("issues"), NOW), "issues.duration.cycle.median");
    assert.equal(cycle.value, 7);
    assert.equal(cycle.sampleSize, 1);
    assert.deepEqual(cycle.detail.ids, ["cycle-progress", "cycle-review", "cycle-blocked", "cycle-done"]);
  });

  test("coalesces every stale-label removal when the prior title is unprefixed", () => {
    const data = fixture();
    data.issues = [issue({ id: 101, number: 1, status: "DONE", statusLabels: ["status:done"] })];
    data.events = [
      event("app-progress-label", 1, "labeled", "2026-03-02T00:00:00.000Z", { label: "status:in-progress" }),
      event("app-progress-rename", 1, "renamed", "2026-03-02T00:00:00.100Z", { rename: { from: "Issue 1", to: "[IN PROGRESS] Issue 1" } }),
      event("app-progress-unlabel", 1, "unlabeled", "2026-03-02T00:00:00.200Z", { label: "status:todo" }),
      event("app-progress-unlabel-extra", 1, "unlabeled", "2026-03-02T00:00:00.300Z", { label: "status:backlog" }),
      event("app-review-label", 1, "labeled", "2026-03-05T00:00:00.000Z", { label: "status:review" }),
      event("app-review-rename", 1, "renamed", "2026-03-05T00:00:00.100Z", { rename: { from: "[IN PROGRESS] Issue 1", to: "[REVIEW] Issue 1" } }),
      event("app-review-unlabel", 1, "unlabeled", "2026-03-05T00:00:00.200Z", { label: "status:in-progress" }),
      event("app-done-label", 1, "labeled", "2026-03-09T00:00:00.000Z", { label: "status:done" }),
      event("app-done-rename", 1, "renamed", "2026-03-09T00:00:00.100Z", { rename: { from: "[REVIEW] Issue 1", to: "[DONE] Issue 1" } }),
      event("app-done-unlabel", 1, "unlabeled", "2026-03-09T00:00:00.200Z", { label: "status:review" }),
    ];
    const cycle = value(buildAnalyticsSection(data, query("issues"), NOW), "issues.duration.cycle.median");
    assert.equal(cycle.value, 7);
    assert.equal(cycle.sampleSize, 1);
    assert.equal(cycle.coverage, "complete");
    assert.deepEqual(cycle.detail.ids, data.events.map((item) => item.id));
  });

  test("invalidates a cycle on a contradictory removal outside an app transition", () => {
    const data = fixture();
    data.issues = [issue({ id: 101, number: 1, status: "DONE", statusLabels: ["status:done"] })];
    data.events = [
      event("conflict-progress", 1, "labeled", "2026-03-02T00:00:00.000Z", { label: "status:in-progress" }),
      event("conflict-review-label", 1, "labeled", "2026-03-04T00:00:00.000Z", { label: "status:review" }),
      event("conflict-review-rename", 1, "renamed", "2026-03-04T00:00:00.100Z", { rename: { from: "[IN PROGRESS] Issue 1", to: "[REVIEW] Issue 1" } }),
      event("conflict-review-unlabel", 1, "unlabeled", "2026-03-04T00:00:00.200Z", { label: "status:in-progress" }),
      event("contradictory-unlabel", 1, "unlabeled", "2026-03-05T00:00:00.000Z", { label: "status:in-progress" }),
      event("conflict-done", 1, "labeled", "2026-03-06T00:00:00.000Z", { label: "status:done" }),
    ];
    const cycle = value(buildAnalyticsSection(data, query("issues"), NOW), "issues.duration.cycle.median");
    assert.equal(cycle.value, null);
    assert.equal(cycle.sampleSize, 0);
    assert.equal(cycle.coverage, "partial");
    assert.ok(cycle.warnings.some((item) => item.code === "unknown-history-facts"));
  });

  test("resets cycles on reopen or a new IN PROGRESS transition", () => {
    const data = fixture();
    data.issues = [
      issue({ id: 101, number: 1, status: "DONE", statusLabels: ["status:done"] }),
      issue({ id: 102, number: 2, status: "DONE", statusLabels: ["status:done"] }),
    ];
    data.events = [
      event("abandoned-progress", 1, "labeled", "2026-03-02T00:00:00.000Z", { label: "status:in-progress" }),
      event("cycle-reopen", 1, "reopened", "2026-03-03T00:00:00.000Z"),
      event("abandoned-done", 1, "labeled", "2026-03-04T00:00:00.000Z", { label: "status:done" }),
      event("first-progress", 2, "labeled", "2026-03-02T00:00:00.000Z", { label: "status:in-progress" }),
      event("first-review", 2, "labeled", "2026-03-04T00:00:00.000Z", { label: "status:review" }),
      event("reset-progress", 2, "labeled", "2026-03-10T00:00:00.000Z", { label: "status:in-progress" }),
      event("reset-done", 2, "labeled", "2026-03-12T00:00:00.000Z", { label: "status:done" }),
    ];
    const cycle = value(buildAnalyticsSection(data, query("issues"), NOW), "issues.duration.cycle.median");
    assert.equal(cycle.value, 2);
    assert.equal(cycle.sampleSize, 1);
    assert.deepEqual(cycle.detail.ids, ["reset-progress", "reset-done"]);
  });

  test("keeps cycles unknown when missing status history breaks continuity", () => {
    const data = fixture();
    data.issues = [issue({ id: 101, number: 1, status: "DONE", statusLabels: ["status:done"] })];
    data.events = [
      event("unknown-progress", 1, "labeled", "2026-03-02T00:00:00.000Z", { label: "status:in-progress" }),
      event("unknown-rename", 1, "renamed", "2026-03-04T00:00:00.000Z"),
      event("unknown-done", 1, "labeled", "2026-03-06T00:00:00.000Z", { label: "status:done" }),
    ];
    const cycle = value(buildAnalyticsSection(data, query("issues"), NOW), "issues.duration.cycle.median");
    assert.equal(cycle.value, null);
    assert.equal(cycle.sampleSize, 0);
    assert.equal(cycle.coverage, "partial");
    assert.ok(cycle.warnings.some((item) => item.code === "unknown-history-facts"));
  });

  test("uses current state and status independently, dedupes IDs, warns on conflicts, and handles assignees/bots", () => {
    const payload = buildAnalyticsSection(fixture(), query("issues"), NOW);
    assert.equal(value(payload, "issues.current.open").value, 3);
    assert.equal(value(payload, "issues.current.in_progress").value, 1);
    assert.equal(value(payload, "issues.current.blocked").value, 1);
    assert.equal(value(payload, "issues.current.assignee_distribution").value, 3);
    assert.ok(value(payload, "issues.current.in_progress").warnings.some((item) => item.code === "status-conflict"));
    const withBots = buildAnalyticsSection(fixture(), query("issues", { includeBots: true }), NOW);
    assert.equal(value(withBots, "issues.current.open").value, 4);
    assert.equal(value(withBots, "issues.current.assignee_distribution").value, 5);
  });

  test("treats no-role person filters as any attributable issue role per metric", () => {
    const data = fixture();
    data.issues = [
      issue({ id: 101, number: 1, author: human }),
      issue({ id: 102, number: 2, author: reviewer, assignees: [human] }),
      issue({ id: 103, number: 3, author: reviewer }),
    ];
    data.events = [
      event("assignee-close", 2, "closed", "2026-03-10T00:00:00.000Z", { actor: reviewer }),
      event("actor-close", 3, "closed", "2026-03-11T00:00:00.000Z", { actor: human }),
    ];
    const payload = buildAnalyticsSection(data, query("issues", { person: human.id, role: null }), NOW);
    assert.equal(value(payload, "issues.current.open").value, 2);
    assert.deepEqual(value(payload, "issues.current.open").detail.ids, ["101", "102"]);
    assert.equal(value(payload, "issues.period.closed_events").value, 1);
    assert.deepEqual(value(payload, "issues.period.closed_events").detail.ids, ["actor-close"]);
    const records = payload.tables.find((item) => item.id === "issues.records");
    const currentStatus = payload.charts.find((item) => item.id === "issues.current.status_distribution");
    assert.ok(records);
    assert.ok(currentStatus);
    assert.deepEqual(records.rows.map((row) => row._detailIds), ["101", "102", "103"]);
    assert.deepEqual(currentStatus.series.flatMap((series) => series.points).flatMap((item) => item.detail.ids).sort(), ["101", "102"]);

    const byAssignee = buildAnalyticsSection(data, query("issues", { person: human.id, role: "assignee" }), NOW);
    assert.deepEqual(value(byAssignee, "issues.current.open").detail.ids, ["102"]);
    assert.deepEqual(byAssignee.tables.find((item) => item.id === "issues.records")?.rows.map((row) => row._detailIds), ["102"]);
  });

  test("reports optional history as unavailable rather than fabricating from closed_at", () => {
    const data = fixture();
    data.events = [];
    data.coverage = data.coverage.map((item) => item.id === "issue-events" ? source("issue-events", "unsupported") : item);
    const payload = buildAnalyticsSection(data, query("issues"), NOW);
    assert.equal(value(payload, "issues.period.closed_events").value, null);
    assert.equal(value(payload, "issues.duration.close.median").value, null);
    assert.equal(value(payload, "issues.period.opened_events").value, 5);
    assert.equal(value(payload, "issues.period.closed_events").coverage, "unsupported");
    assert.ok(value(payload, "issues.period.closed_events").warnings.length > 0);
  });

  test("labels issue history rows as sparse boundary samples", () => {
    const payload = buildAnalyticsSection(fixture(), query("issues"), NOW);
    const history = payload.tables.find((item) => item.id === "issues.history");
    assert.ok(history);
    assert.equal(history.title, "Issue history audit samples");
    assert.match(history.description, /Sparse reconstructed.+first, last, and event-adjacent.+does not emit every bucket/);
    assert.match(history.scope, /Sparse first, last, and event-adjacent boundary samples/);
    assert.equal(history.columns[0]?.label, "Sampled period");
    assert.doesNotMatch(history.scope, /each selected bucket boundary/);
  });

  test("replays rename and status facts backward and exposes auditable event rows", () => {
    const data = fixture();
    data.issues = [issue({ id: 101, number: 1, title: "New title", fullTitle: "[DONE] New title", status: "DONE", statusLabels: ["status:done"] })];
    data.events = [
      event("todo-1", 1, "labeled", "2026-03-02T00:00:00.000Z", { label: "status:todo" }),
      event("untodo-1", 1, "unlabeled", "2026-03-20T00:00:00.000Z", { label: "status:todo" }),
      event("done-1", 1, "labeled", "2026-03-20T00:00:01.000Z", { label: "status:done" }),
      event("rename-1", 1, "renamed", "2026-03-20T00:00:02.000Z", { rename: { from: "[DONE] Old title", to: "[DONE] New title" } }),
    ];
    const payload = buildAnalyticsSection(data, query("issues"), NOW);
    const history = payload.tables.find((item) => item.id === "issues.history");
    const events = payload.tables.find((item) => item.id === "issues.events");
    assert.ok(history);
    assert.ok(events);
    assert.ok(history.rows.some((row) => row.title === "Old title" && row.status === "TODO" && row.proven === true));
    assert.deepEqual(events.rows.find((row) => row.eventId === "rename-1"), {
      eventId: "rename-1", issue: 1, type: "renamed", createdAt: "2026-03-20T00:00:02.000Z", actor: "Alice",
      label: null, status: null, renameFrom: "[DONE] Old title", renameTo: "[DONE] New title", milestone: null,
      _detailKind: "issue-event", _detailIds: "rename-1",
    });
    data.events = [event("rename-missing", 1, "renamed", "2026-03-20T00:00:02.000Z")];
    const partial = buildAnalyticsSection(data, query("issues"), NOW);
    assert.equal(value(partial, "issues.history.cumulative_flow").coverage, "partial");
    assert.ok(value(partial, "issues.history.cumulative_flow").warnings.some((item) => item.code === "unknown-history-facts"));
  });

  test("replays title-only status transitions from full GitHub rename strings", () => {
    const data = fixture();
    data.issues = [issue({ id: 101, number: 1, title: "New title", fullTitle: "[DONE] New title", status: "DONE", labels: [], statusLabels: [] })];
    data.events = [
      event("prefix-rename", 1, "renamed", "2026-03-20T00:00:00.000Z", {
        rename: { from: "[TODO] Old title", to: "[DONE] New title" },
      }),
    ];
    const payload = buildAnalyticsSection(data, query("issues"), NOW);
    const history = payload.tables.find((item) => item.id === "issues.history");
    const events = payload.tables.find((item) => item.id === "issues.events");
    assert.ok(history);
    assert.ok(events);
    assert.ok(history.rows.some((row) => row.title === "Old title" && row.status === "TODO" && row.proven === true));
    assert.equal(history.rows.some((row) => row.title === "[TODO] Old title"), false);
    assert.equal(value(payload, "issues.period.completed_unique").value, 1);
    assert.deepEqual(events.rows.find((row) => row.eventId === "prefix-rename")?.renameFrom, "[TODO] Old title");
  });

  test("filters every issue chart and table by actor applicability and hides all reviewer rows", () => {
    const data = fixture();
    data.issues = [
      issue({ id: 101, number: 1, author: human }),
      issue({ id: 102, number: 2, author: reviewer }),
    ];
    data.events = [
      event("close-by-bob", 1, "closed", "2026-03-10T00:00:00.000Z", { actor: reviewer }),
      event("close-by-alice", 2, "closed", "2026-03-11T00:00:00.000Z", { actor: human }),
    ];
    const byAuthor = buildAnalyticsSection(data, query("issues", { person: human.id, role: "author" }), NOW);
    const byActor = buildAnalyticsSection(data, query("issues", { person: reviewer.id, role: "actor" }), NOW);
    const wrongActor = buildAnalyticsSection(data, query("issues", { person: human.id, role: "actor" }), NOW);
    const byReviewer = buildAnalyticsSection(data, query("issues", { person: human.id, role: "reviewer" }), NOW);
    assert.equal(value(byAuthor, "issues.period.closed_events").value, 1);
    assert.equal(value(byActor, "issues.period.closed_events").value, 1);
    assert.deepEqual(value(byActor, "issues.period.closed_events").detail.ids, ["close-by-bob"]);
    assert.deepEqual(value(wrongActor, "issues.period.closed_events").detail.ids, ["close-by-alice"]);
    assert.equal(value(byActor, "issues.current.open").value, null);
    const actorActivity = byActor.charts.find((item) => item.id === "issues.period.activity");
    const actorStatus = byActor.charts.find((item) => item.id === "issues.current.status_distribution");
    const actorRecords = byActor.tables.find((item) => item.id === "issues.records");
    const actorEvents = byActor.tables.find((item) => item.id === "issues.events");
    const actorHistory = byActor.tables.find((item) => item.id === "issues.history");
    assert.ok(actorActivity);
    assert.ok(actorStatus);
    assert.ok(actorRecords);
    assert.ok(actorEvents);
    assert.ok(actorHistory);
    assert.deepEqual(actorActivity.series.find((item) => item.id === "closed")?.points.flatMap((item) => item.detail.ids), ["close-by-bob"]);
    assert.ok(actorStatus.series.every((item) => item.points.length === 0));
    assert.deepEqual(actorRecords.rows.map((row) => row._detailIds), ["101"]);
    assert.deepEqual(actorEvents.rows.map((row) => row._detailIds), ["close-by-bob"]);
    assert.equal(actorHistory.rows.length, 0);
    assert.ok(byReviewer.charts.every((item) => item.series.every((series) => series.points.length === 0)));
    assert.ok(byReviewer.tables.every((item) => item.rows.length === 0));
    assert.ok(value(byReviewer, "issues.current.open").warnings.some((item) => item.code === "filter-role-inapplicable"));
  });

  test("combines issue-event hydration coverage for actor and Any record exports", () => {
    const data = fixture();
    data.issues = [issue({ id: 101, number: 1, author: human })];
    data.events = [event("close-by-bob", 1, "closed", "2026-03-10T00:00:00.000Z", { actor: reviewer })];
    data.coverage = data.coverage.map((item) => item.id === "issue-events" ? source("issue-events", "partial") : item);

    for (const role of ["actor", null] as const) {
      for (const section of ["issues", "summary"] as const) {
        const payload = buildAnalyticsSection(data, query(section, { person: reviewer.id, role }), NOW);
        const records = payload.tables.find((item) => item.id === "issues.records");
        assert.ok(records);
        assert.equal(records.coverage, "partial");
        assert.ok(records.warnings.some((item) => item.source === "issue-events"));
        assert.ok(analyticsTableCsv(payload, "issues.records").includes("# Coverage,partial"));
      }
    }
  });

  test("uses fixed median midpoint and nearest-rank P75 including empty samples", () => {
    assert.equal(analyticsMedian([4, 1, 3, 2]), 2.5);
    assert.equal(analyticsP75([4, 1, 3, 2]), 3);
    assert.equal(analyticsMedian([]), null);
    assert.equal(analyticsP75([]), null);
  });
});

describe("pull request and contributor metrics", () => {
  test("handles ready episodes, latest reviewer decisions, pending/dismissed reviews, and request age", () => {
    const payload = buildAnalyticsSection(fixture(), query("pull-requests"), NOW);
    assert.equal(value(payload, "prs.period.merged").value, 1);
    assert.equal(value(payload, "prs.period.closed_unmerged").value, 1);
    assert.equal(value(payload, "prs.current.review_waiting").value, 1);
    assert.equal(value(payload, "prs.current.changes_requested").value, 1);
    assert.equal(value(payload, "prs.duration.first_review.median").value, 9);
    assert.equal(value(payload, "prs.duration.ready_review.median").value, 1);
    assert.equal(value(payload, "prs.duration.ready_merge.median").value, 3);
    assert.equal(value(payload, "prs.reviews.submitted").value, 5);
    assert.equal(value(payload, "prs.reviews.reviewed_unique").value, 2);
    assert.equal(value(payload, "prs.current.request_wait").value, 12.5);
    assert.equal(value(payload, "prs.current.stale_review").value, 1);
  });

  test("excludes pre-ready reviews and orders latest decisions by review-submitted event time", () => {
    const data = fixture();
    data.pullRequests = [pull({ id: 210, number: 10 })];
    data.reviews = [
      { id: 301, pullNumber: 10, reviewer, state: "approved", submittedAt: "2026-03-02T00:00:00.000Z", commitId: null, url: null },
      { id: 302, pullNumber: 10, reviewer, state: "changes-requested", submittedAt: "2026-03-21T00:00:00.000Z", commitId: null, url: null },
      { id: 303, pullNumber: 10, reviewer, state: "approved", submittedAt: "2026-03-20T00:00:00.000Z", commitId: null, url: null },
    ];
    data.events = [
      event("ready-10", 10, "ready-for-review", "2026-03-05T00:00:00.000Z"),
      event("review-302", 10, "review-submitted", "2026-03-10T00:00:00.000Z", { actor: reviewer, reviewer, reviewId: 302, reviewState: "changes-requested" }),
      event("review-303", 10, "review-submitted", "2026-03-11T00:00:00.000Z", { actor: reviewer, reviewer, reviewId: 303, reviewState: "approved" }),
      event("review-301", 10, "review-submitted", "2026-03-12T00:00:00.000Z", { actor: reviewer, reviewer, reviewId: 301, reviewState: "approved" }),
    ];
    const payload = buildAnalyticsSection(data, query("pull-requests"), NOW);
    assert.equal(value(payload, "prs.duration.first_review.median").value, 1);
    assert.equal(value(payload, "prs.duration.ready_review.median").value, 15);
    assert.equal(value(payload, "prs.duration.ready_review.median").detail.ids[0], "303");
    assert.equal(value(payload, "prs.current.changes_requested").value, 0);
    assert.equal(value(payload, "prs.current.changes_requested").coverage, "complete");
  });

  test("keeps team review requests explicit and marks individual request coverage partial", () => {
    const data = fixture();
    data.pullRequests.push(pull({ id: 214, number: 14, requestedTeams: ["platform"], reviewState: "review-required" }));
    const pulls = buildAnalyticsSection(data, query("pull-requests"), NOW);
    const contributors = buildAnalyticsSection(data, query("contributors"), NOW);
    assert.equal(value(pulls, "prs.current.review_waiting").value, 2);
    assert.equal(value(pulls, "prs.current.review_waiting").coverage, "partial");
    assert.equal(value(pulls, "prs.current.request_wait").coverage, "partial");
    assert.ok(value(pulls, "prs.current.request_wait").warnings.some((item) => item.source === "review-requests"));
    assert.equal(value(contributors, "people.current.review_requests").coverage, "partial");
  });

  test("applies contributor person filters only to supported roles", () => {
    const byAuthor = buildAnalyticsSection(fixture(), query("contributors", { person: human.id, role: "author" }), NOW);
    const byReviewer = buildAnalyticsSection(fixture(), query("contributors", { person: reviewer.id, role: "reviewer" }), NOW);
    const byActor = buildAnalyticsSection(fixture(), query("contributors", { person: human.id, role: "actor" }), NOW);
    assert.ok((value(byAuthor, "people.period.issues_authored").value ?? 0) > 0);
    assert.equal(value(byAuthor, "people.period.reviews_submitted").value, null);
    assert.ok((value(byReviewer, "people.period.reviews_submitted").value ?? 0) > 0);
    assert.equal(value(byReviewer, "people.period.issues_authored").value, null);
    assert.equal(value(byActor, "people.period.contribution_trend").value, null);
  });

  test("unions contributor role families for Any and omits unsupported actor outputs", () => {
    const anyRole = buildAnalyticsSection(fixture(), query("contributors", { person: reviewer.id, role: null }), NOW);
    assert.equal(value(anyRole, "people.current.assigned_open").value, 1);
    assert.equal(value(anyRole, "people.current.review_requests").value, 1);
    assert.equal(value(anyRole, "people.period.reviews_submitted").value, 4);
    const currentWork = anyRole.charts.find((item) => item.id === "people.current.work");
    const contributorRows = anyRole.tables.find((item) => item.id === "people.contributors");
    assert.ok(currentWork);
    assert.ok(contributorRows);
    assert.deepEqual(currentWork.series.map((item) => item.id), ["assigned", "in-progress", "blocked", "requests"]);
    assert.equal(contributorRows.rows.length, 1);
    assert.ok(Object.values(contributorRows.rows[0]!).every((item) => item !== undefined));
    const byAssignee = buildAnalyticsSection(fixture(), query("contributors", { person: reviewer.id, role: "assignee" }), NOW);
    assert.equal(value(byAssignee, "people.current.assigned_open").value, 1);
    assert.equal(value(byAssignee, "people.current.review_requests").value, null);
    assert.deepEqual(byAssignee.charts.find((item) => item.id === "people.current.work")?.series.map((item) => item.id), ["assigned", "in-progress", "blocked"]);
    assert.equal(byAssignee.tables[0]?.rows[0]?.reviewRequests, null);

    const byActor = buildAnalyticsSection(fixture(), query("contributors", { person: reviewer.id, role: "actor" }), NOW);
    assert.ok(byActor.metrics.every((item) => item.value === null));
    assert.ok(byActor.charts.every((item) => item.series.every((series) => series.points.length === 0)));
    assert.ok(byActor.tables.every((item) => item.rows.length === 0));
  });

  test("applies PR author, reviewer, and actor filters only to attributable metrics", () => {
    const byAuthor = buildAnalyticsSection(fixture(), query("pull-requests", { person: human.id, role: "author" }), NOW);
    const byReviewer = buildAnalyticsSection(fixture(), query("pull-requests", { person: human.id, role: "reviewer" }), NOW);
    const byActor = buildAnalyticsSection(fixture(), query("pull-requests", { person: human.id, role: "actor" }), NOW);
    assert.ok((value(byAuthor, "prs.period.opened").value ?? 0) > 0);
    assert.equal(value(byReviewer, "prs.reviews.submitted").value, 1);
    assert.equal(value(byReviewer, "prs.period.opened").value, null);
    assert.equal(value(byActor, "prs.current.changes_requested").value, 1);
    assert.equal(value(byActor, "prs.current.state_distribution").value, null);
  });

  test("unions PR assignee, reviewer, and actor evidence under Any without widening author metrics", () => {
    const data = fixture();
    data.pullRequests = [
      pull({ id: 210, number: 10, author: human, requestedReviewers: [reviewer] }),
      pull({ id: 211, number: 11, author: human, assignees: [reviewer] }),
      pull({ id: 212, number: 12, author: reviewer }),
      pull({ id: 213, number: 13, author: human }),
    ];
    data.reviews = [
      { id: 301, pullNumber: 10, reviewer, state: "approved", submittedAt: "2026-03-05T00:00:00.000Z", commitId: null, url: null },
    ];
    data.events = [
      event("actor-change", 13, "review-submitted", "2026-03-15T00:00:00.000Z", { actor: reviewer, reviewState: "changes-requested" }),
    ];
    const payload = buildAnalyticsSection(data, query("pull-requests", { person: reviewer.id, role: null }), NOW);
    assert.equal(value(payload, "prs.period.opened").value, 1);
    assert.deepEqual(value(payload, "prs.period.opened").detail.ids, ["212"]);
    assert.equal(value(payload, "prs.current.state_distribution").value, 2);
    assert.deepEqual(value(payload, "prs.current.state_distribution").detail.ids, ["211", "212"]);
    assert.equal(value(payload, "prs.reviews.submitted").value, 1);
    assert.equal(value(payload, "prs.current.changes_requested").value, 1);
    assert.deepEqual(value(payload, "prs.current.changes_requested").detail.ids, ["213"]);
    const records = payload.tables.find((item) => item.id === "prs.records");
    const activity = payload.charts.find((item) => item.id === "prs.period.activity");
    const state = payload.charts.find((item) => item.id === "prs.current.state_distribution");
    assert.ok(records);
    assert.ok(activity);
    assert.ok(state);
    assert.deepEqual(records.rows.map((row) => row._detailIds), ["210", "211", "212", "213"]);
    assert.deepEqual(new Set(activity.series.flatMap((series) => series.points.flatMap((item) => item.detail.ids))), new Set(["212"]));
    assert.deepEqual(new Set(state.series.flatMap((series) => series.points.flatMap((item) => item.detail.ids))), new Set(["211", "212"]));

    const byAssignee = buildAnalyticsSection(data, query("pull-requests", { person: reviewer.id, role: "assignee" }), NOW);
    assert.equal(value(byAssignee, "prs.current.state_distribution").value, 1);
    assert.deepEqual(value(byAssignee, "prs.current.state_distribution").detail.ids, ["211"]);
    assert.equal(value(byAssignee, "prs.period.opened").value, null);
    assert.deepEqual(byAssignee.tables.find((item) => item.id === "prs.records")?.rows.map((row) => row._detailIds), ["211"]);
    assert.ok(byAssignee.charts.find((item) => item.id === "prs.period.activity")?.series.every((series) => series.points.length === 0));
  });

  test("combines capped and missing role hydration coverage for PR record exports", () => {
    const data = fixture();
    data.pullRequests = [pull({ id: 210, number: 10, author: human })];
    data.reviews = [
      { id: 301, pullNumber: 10, reviewer, state: "approved", submittedAt: "2026-03-10T00:00:00.000Z", commitId: null, url: null },
    ];
    data.events = [
      event("review-301", 10, "review-submitted", "2026-03-10T00:00:00.000Z", { actor: reviewer, reviewer, reviewId: 301, reviewState: "approved" }),
    ];
    data.coverage = data.coverage.map((item) =>
      item.id === "reviews"
        ? source("reviews", "partial")
        : item.id === "timelines"
          ? source("timelines", "unsupported")
          : item);

    const byReviewer = buildAnalyticsSection(data, query("pull-requests", { person: reviewer.id, role: "reviewer" }), NOW);
    const reviewerRecords = byReviewer.tables.find((item) => item.id === "prs.records");
    assert.ok(reviewerRecords);
    assert.equal(reviewerRecords.coverage, "partial");
    assert.ok(reviewerRecords.warnings.some((item) => item.source === "reviews"));
    assert.ok(analyticsTableCsv(byReviewer, "prs.records").includes("# Coverage,partial"));

    const byActor = buildAnalyticsSection(data, query("pull-requests", { person: reviewer.id, role: "actor" }), NOW);
    const actorRecords = byActor.tables.find((item) => item.id === "prs.records");
    assert.ok(actorRecords);
    assert.equal(actorRecords.coverage, "unsupported");
    assert.ok(actorRecords.warnings.some((item) => item.source === "timelines"));
    assert.ok(analyticsTableCsv(byActor, "prs.records").includes("# Coverage,unsupported"));

    const anyRole = buildAnalyticsSection(data, query("summary", { person: reviewer.id, role: null }), NOW);
    const anyRecords = anyRole.tables.find((item) => item.id === "prs.records");
    assert.ok(anyRecords);
    assert.equal(anyRecords.coverage, "unsupported");
    assert.ok(anyRecords.warnings.some((item) => item.source === "reviews"));
    assert.ok(anyRecords.warnings.some((item) => item.source === "timelines"));
  });

  test("keeps deleted authors explicit, filters bots, and counts multi-assignees per person", () => {
    const payload = buildAnalyticsSection(fixture(), query("contributors"), NOW);
    assert.ok(payload.tables[0]!.rows.some((row) => row.person === "Deleted user"));
    assert.ok(payload.tables[0]!.rows.every((row) => row.person !== "Helper"));
    assert.equal(value(payload, "people.current.assigned_open").value, 3);
    assert.equal(value(payload, "people.period.reviews_submitted").value, 5);
    const withBots = buildAnalyticsSection(fixture(), query("contributors", { includeBots: true }), NOW);
    assert.ok(withBots.tables[0]!.rows.some((row) => row.person === "Helper"));
  });

  test("keeps reviewer-scoped contributor trend values and drilldowns in parity", () => {
    const payload = buildAnalyticsSection(fixture(), query("contributors", { person: reviewer.id, role: "reviewer" }), NOW);
    const metric = value(payload, "people.period.contribution_trend");
    const trend = payload.charts.find((item) => item.id === "people.period.contribution_trend");
    assert.ok(trend);
    assert.equal(metric.value, 4);
    assert.deepEqual(trend.series.map((item) => item.id), ["reviews"]);
    assert.equal(trend.series[0]!.points.reduce((sum, item) => sum + item.value, 0), metric.value);
    assert.deepEqual(
      new Set(trend.series[0]!.points.flatMap((item) => item.detail.ids)),
      new Set(["301", "302", "303", "306"]),
    );
  });

  test("excludes first-review latency cohorts whose chosen review is outside the period", () => {
    const data = fixture();
    data.pullRequests = [pull({ id: 210, number: 10, createdAt: "2026-01-01T00:00:00.000Z" })];
    data.reviews = [
      { id: 301, pullNumber: 10, reviewer, state: "approved", submittedAt: "2026-01-03T00:00:00.000Z", commitId: null, url: null },
    ];
    data.events = [
      event("ready-10", 10, "ready-for-review", "2026-01-02T00:00:00.000Z"),
      event("review-301", 10, "review-submitted", "2026-01-03T00:00:00.000Z", { actor: reviewer, reviewer, reviewId: 301, reviewState: "approved" }),
    ];
    const payload = buildAnalyticsSection(data, query("pull-requests"), NOW);
    assert.equal(value(payload, "prs.duration.first_review.median").value, null);
    assert.equal(value(payload, "prs.duration.first_review.median").sampleSize, 0);
    assert.equal(value(payload, "prs.duration.ready_review.median").value, null);
    assert.equal(value(payload, "prs.duration.ready_review.median").sampleSize, 0);
    assert.equal(value(payload, "prs.reviews.submitted").value, 0);
  });

  test("counts dismissed submissions historically but not as current decisions or latency", () => {
    const data = fixture();
    data.issues = [];
    data.pullRequests = [pull({ id: 210, number: 10 })];
    data.reviews = [
      { id: 301, pullNumber: 10, reviewer, state: "dismissed", submittedAt: "2026-03-10T00:00:00.000Z", commitId: null, url: null },
    ];
    data.events = [
      event("ready-10", 10, "ready-for-review", "2026-03-05T00:00:00.000Z"),
      event("review-301", 10, "review-submitted", "2026-03-10T00:00:00.000Z", { actor: reviewer, reviewer, reviewId: 301, reviewState: "dismissed" }),
    ];
    const pulls = buildAnalyticsSection(data, query("pull-requests"), NOW);
    const contributors = buildAnalyticsSection(data, query("contributors", { person: reviewer.id, role: "reviewer" }), NOW);
    assert.equal(value(pulls, "prs.reviews.submitted").value, 1);
    assert.equal(value(pulls, "prs.reviews.reviewed_unique").value, 1);
    assert.equal(value(pulls, "prs.current.changes_requested").value, 0);
    assert.equal(value(pulls, "prs.duration.first_review.median").value, null);
    assert.equal(value(pulls, "prs.duration.ready_review.median").value, null);
    assert.equal(value(contributors, "people.period.prs_reviewed").value, 1);
    assert.equal(value(contributors, "people.period.reviews_submitted").value, 1);
  });

  test("keeps a changes-requested decision when a later submission is only COMMENTED", () => {
    const data = fixture();
    data.pullRequests = [pull({ id: 210, number: 10, createdAt: "2026-03-01T00:00:00.000Z" })];
    data.reviews = [
      { id: 301, pullNumber: 10, reviewer, state: "changes-requested", submittedAt: "2026-03-10T00:00:00.000Z", commitId: null, url: null },
      { id: 302, pullNumber: 10, reviewer, state: "commented", submittedAt: "2026-03-11T00:00:00.000Z", commitId: null, url: null },
    ];
    data.events = [
      event("ready-10", 10, "ready-for-review", "2026-03-05T00:00:00.000Z"),
      event("review-301", 10, "review-submitted", "2026-03-10T00:00:00.000Z", { actor: reviewer, reviewer, reviewId: 301, reviewState: "changes-requested" }),
      event("review-302", 10, "review-submitted", "2026-03-11T00:00:00.000Z", { actor: reviewer, reviewer, reviewId: 302, reviewState: "commented" }),
    ];
    const payload = buildAnalyticsSection(data, query("pull-requests"), NOW);
    assert.equal(value(payload, "prs.current.changes_requested").value, 1);
    assert.equal(value(payload, "prs.duration.first_review.median").value, 9);
    assert.equal(value(payload, "prs.duration.ready_review.median").value, 5);
    assert.equal(value(payload, "prs.reviews.submitted").value, 2);
  });

  test("counts COMMENTED submissions without creating first or ready review latency", () => {
    const data = fixture();
    data.pullRequests = [pull({ id: 210, number: 10, createdAt: "2026-03-01T00:00:00.000Z" })];
    data.reviews = [
      { id: 301, pullNumber: 10, reviewer, state: "commented", submittedAt: "2026-03-10T00:00:00.000Z", commitId: null, url: null },
    ];
    data.events = [
      event("ready-10", 10, "ready-for-review", "2026-03-05T00:00:00.000Z"),
      event("review-301", 10, "review-submitted", "2026-03-10T00:00:00.000Z", { actor: reviewer, reviewer, reviewId: 301, reviewState: "commented" }),
    ];
    const payload = buildAnalyticsSection(data, query("pull-requests"), NOW);
    assert.equal(value(payload, "prs.current.changes_requested").value, 0);
    assert.equal(value(payload, "prs.reviews.submitted").value, 1);
    assert.equal(value(payload, "prs.duration.first_review.median").value, null);
    assert.equal(value(payload, "prs.duration.first_review.median").sampleSize, 0);
    assert.equal(value(payload, "prs.duration.ready_review.median").value, null);
    assert.equal(value(payload, "prs.duration.ready_review.median").sampleSize, 0);
  });

  test("isolates current request metrics from a selected reviewer's old review history", () => {
    const data = fixture();
    data.pullRequests = [pull({ id: 210, number: 10, author: reviewer, requestedReviewers: [reviewer], reviewState: "review-required" })];
    data.reviews = [
      { id: 301, pullNumber: 10, reviewer: human, state: "approved", submittedAt: "2026-03-10T00:00:00.000Z", commitId: null, url: null },
    ];
    data.events = [
      event("review-301", 10, "review-submitted", "2026-03-10T00:00:00.000Z", { actor: human, reviewer: human, reviewId: 301, reviewState: "approved" }),
      event("request-bob", 10, "review-requested", "2026-03-20T00:00:00.000Z", { actor: reviewer, reviewer }),
    ];
    const payload = buildAnalyticsSection(data, query("pull-requests", { person: human.id, role: "reviewer" }), NOW);
    const requestTable = payload.tables.find((item) => item.id === "prs.review_requests");
    assert.ok(requestTable);
    assert.equal(value(payload, "prs.current.review_waiting").value, 0);
    assert.equal(value(payload, "prs.current.request_wait").value, null);
    assert.equal(value(payload, "prs.current.request_wait").sampleSize, 0);
    assert.equal(value(payload, "prs.current.stale_review").value, 0);
    assert.equal(requestTable.rows.length, 0);
  });

  test("marks the contributor current-work chart partial for team-only review requests", () => {
    const data = fixture();
    data.issues = [];
    data.pullRequests = [pull({ id: 210, number: 10, requestedTeams: ["platform"], reviewState: "review-required" })];
    data.reviews = [];
    data.events = [];
    const payload = buildAnalyticsSection(data, query("contributors"), NOW);
    const currentWork = payload.charts.find((item) => item.id === "people.current.work");
    assert.ok(currentWork);
    assert.equal(currentWork.coverage, "partial");
    assert.ok(currentWork.warnings.some((item) => item.code === "team-review-requests" && item.source === "review-requests"));
  });
});

describe("milestone, repository, bootstrap, and metric contracts", () => {
  test("calculates current milestone progress separately from known event history", () => {
    const payload = buildAnalyticsSection(fixture(), query("milestones", { milestone: 1 }), NOW);
    assert.equal(value(payload, "milestones.current.open").value, 1);
    assert.equal(value(payload, "milestones.current.overdue").value, 1);
    assert.equal(value(payload, "milestones.current.issue_progress").numerator, 2);
    assert.equal(value(payload, "milestones.current.issue_progress").denominator, 4);
    assert.equal(value(payload, "milestones.current.issue_progress").value, 50);
    assert.equal(value(payload, "milestones.history.scope").value, 1);
    assert.equal(value(payload, "milestones.history.burnup").value, 1);
  });

  test("unions milestone assignee and actor evidence while hiding milestone-global and reviewer-unsupported outputs", () => {
    const data = fixture();
    data.issues = [
      issue({ id: 101, number: 1, author: human, milestone }),
      issue({ id: 102, number: 2, author: human, assignees: [reviewer], milestone }),
    ];
    data.pullRequests = [
      pull({ id: 210, number: 10, author: human, requestedReviewers: [reviewer], milestone }),
      pull({ id: 211, number: 11, author: human, assignees: [reviewer], milestone }),
      pull({ id: 212, number: 12, author: reviewer, milestone }),
    ];
    data.reviews = [
      { id: 301, pullNumber: 10, reviewer, state: "approved", submittedAt: "2026-03-05T00:00:00.000Z", commitId: null, url: null },
    ];
    data.events = [
      event("member-actor-issue", 1, "milestoned", "2026-03-02T00:00:00.000Z", { milestoneTitle: "0.5" }),
      event("close-by-bob", 1, "closed", "2026-03-10T00:00:00.000Z", { actor: reviewer }),
    ];

    const anyRole = buildAnalyticsSection(data, query("milestones", { milestone: 1, person: reviewer.id, role: null }), NOW);
    assert.equal(value(anyRole, "milestones.current.open").value, null);
    assert.equal(value(anyRole, "milestones.current.open").sampleSize, 0);
    assert.equal(value(anyRole, "milestones.current.issue_progress").denominator, 1);
    assert.equal(value(anyRole, "milestones.current.pr_progress").denominator, 2);
    assert.deepEqual(value(anyRole, "milestones.current.pr_progress").detail.ids, ["211", "212"]);
    assert.equal(value(anyRole, "milestones.history.scope").value, 0);
    assert.equal(value(anyRole, "milestones.history.burnup").value, 1);
    assert.deepEqual(value(anyRole, "milestones.history.burnup").detail.ids, ["close-by-bob"]);
    assert.equal(anyRole.tables.find((item) => item.id === "milestones.records")?.rows.length, 0);
    assert.deepEqual(anyRole.tables.find((item) => item.id === "milestones.issue_members")?.rows.map((row) => row._detailIds), ["102"]);
    assert.deepEqual(anyRole.tables.find((item) => item.id === "milestones.events")?.rows.map((row) => row._detailIds), ["close-by-bob"]);

    const byReviewer = buildAnalyticsSection(data, query("milestones", { milestone: 1, person: reviewer.id, role: "reviewer" }), NOW);
    assert.equal(value(byReviewer, "milestones.current.pr_progress").value, null);
    assert.ok(value(byReviewer, "milestones.current.pr_progress").warnings.some((item) => item.code === "filter-role-inapplicable"));
    assert.ok(byReviewer.charts.every((item) => item.series.every((series) => series.points.length === 0)));
    assert.ok(byReviewer.tables.every((item) => item.rows.length === 0));
  });

  test("models named milestone transfers and scopes closes to active membership at event time", () => {
    const data = fixture();
    data.issues = [
      issue({ id: 101, number: 1, milestone: { ...milestone, number: 2, title: "0.4" } }),
      issue({ id: 102, number: 2, milestone }),
    ];
    data.events = [
      event("member-a-1", 1, "milestoned", "2026-03-02T00:00:00.000Z", { milestoneTitle: "0.5" }),
      event("close-in-a", 1, "closed", "2026-03-05T00:00:00.000Z"),
      event("member-b-1", 1, "milestoned", "2026-03-10T00:00:00.000Z", { milestoneTitle: "0.4" }),
      event("close-before-a", 2, "closed", "2026-03-01T00:00:00.000Z"),
      event("member-a-2", 2, "milestoned", "2026-03-03T00:00:00.000Z", { milestoneTitle: "0.5" }),
    ];
    const payload = buildAnalyticsSection(data, query("milestones", { milestone: 1 }), NOW);
    assert.equal(value(payload, "milestones.history.scope").value, 1);
    assert.equal(value(payload, "milestones.history.burnup").value, 1);
    assert.deepEqual(value(payload, "milestones.history.burnup").detail.ids, ["close-in-a"]);
  });

  test("does not wildcard historical events for a stale milestone filter", () => {
    const payload = buildAnalyticsSection(fixture(), query("milestones", { milestone: 999 }), NOW);
    for (const id of ["milestones.history.scope", "milestones.history.burnup"]) {
      const historical = value(payload, id);
      assert.equal(historical.value, null);
      assert.equal(historical.coverage, "unsupported");
      assert.deepEqual(historical.detail.ids, []);
      assert.ok(historical.warnings.some((item) => item.code === "unknown-milestone-filter" && item.source === "milestones"));
    }
    const burnup = payload.charts.find((item) => item.id === "milestones.history.burnup");
    assert.ok(burnup);
    assert.equal(burnup.coverage, "unsupported");
    assert.ok(burnup.series.every((series) => series.points.every((item) => item.value === 0)));
    assert.ok(payload.warnings.some((item) => item.code === "unknown-milestone-filter" && item.excluded > 0));
  });

  test("replays a large milestone transfer and close stream in chronological order", () => {
    const data = fixture();
    const previous = { ...milestone, number: 2, title: "0.4", state: "closed" as const, dueOn: null, closedAt: "2026-02-01T00:00:00.000Z" };
    const count = 2_000;
    data.issues = Array.from({ length: count }, (_, index) => issue({ id: 10_000 + index, number: index + 1, milestone: previous }));
    data.events = [];
    for (let index = count - 1; index >= 0; index -= 1) {
      const number = index + 1;
      data.events.push(event(`transfer-${number}`, number, "milestoned", "2026-03-04T00:00:00.000Z", { subject: "issue", milestoneTitle: "0.4" }));
      data.events.push(event(`close-after-${number}`, number, "closed", "2026-03-05T00:00:00.000Z", { subject: "issue" }));
      if (index < count / 2) data.events.push(event(`close-before-${number}`, number, "closed", "2026-03-03T00:00:00.000Z", { subject: "issue" }));
      data.events.push(event(`member-${number}`, number, "milestoned", "2026-03-02T00:00:00.000Z", { subject: "issue", milestoneTitle: "0.5" }));
    }
    let timestampReads = 0;
    for (const item of data.events) {
      const createdAt = item.createdAt;
      Object.defineProperty(item, "createdAt", { get() { timestampReads += 1; return createdAt; } });
    }
    const payload = buildAnalyticsSection(data, query("milestones", { milestone: 1 }), NOW);
    assert.equal(value(payload, "milestones.history.scope").value, 0);
    assert.equal(value(payload, "milestones.history.burnup").value, count / 2);
    assert.equal(value(payload, "milestones.history.burnup").detail.ids.length, count / 2);
    assert.ok(timestampReads <= data.events.length * 3, `milestone replay read ${timestampReads} timestamps for ${data.events.length} events`);
  });

  test("does not expose partial loaded populations as complete progress denominators", () => {
    const data = fixture();
    data.coverage = data.coverage.map((item) => item.id === "issues" ? source("issues", "partial") : item);
    const payload = buildAnalyticsSection(data, query("milestones", { milestone: 1 }), NOW);
    assert.equal(value(payload, "milestones.current.issue_progress").coverage, "partial");
    assert.equal(value(payload, "milestones.current.issue_progress").value, null);
    assert.equal(value(payload, "milestones.current.issue_progress").numerator, null);
    assert.equal(value(payload, "milestones.current.issue_progress").denominator, null);
  });

  test("combines dependency coverage into remaining blocked milestone work", () => {
    const data = fixture();
    data.coverage = data.coverage.map((item) => item.id === "dependencies" ? source("dependencies", "partial") : item);
    const payload = buildAnalyticsSection(data, query("milestones", { milestone: 1 }), NOW);
    assert.equal(value(payload, "milestones.current.remaining_blocked").value, 2);
    assert.equal(value(payload, "milestones.current.remaining_blocked").coverage, "partial");
    assert.ok(value(payload, "milestones.current.remaining_blocked").warnings.some((item) => item.source === "dependencies"));
  });

  test("returns null percentage for a zero denominator", () => {
    const data = fixture();
    data.issues = [];
    data.pullRequests = [];
    const payload = buildAnalyticsSection(data, query("milestones", { milestone: 2 }), NOW);
    assert.equal(value(payload, "milestones.current.issue_progress").value, null);
    assert.equal(value(payload, "milestones.current.issue_progress").numerator, 0);
    assert.equal(value(payload, "milestones.current.issue_progress").denominator, 0);
  });

  test("keeps narrow summary outputs identical to their owning sections", () => {
    const data = fixture();
    const metricIds = [
      "issues.current.open", "issues.period.opened_events", "issues.period.closed_unique", "issues.current.stale",
      "prs.period.opened", "prs.period.merged", "prs.current.review_waiting", "milestones.current.overdue",
      "repository.releases.published",
    ];
    const chartIds = ["issues.period.activity", "issues.current.status_distribution", "prs.period.activity", "prs.current.state_distribution"];
    const tableIds = ["issues.records", "prs.records"];
    const scopes: Partial<AnalyticsQuery>[] = [
      {},
      { person: human.id, role: null },
      { person: human.id, role: "actor" },
      { person: human.id, role: "reviewer" },
    ];
    for (const scope of scopes) {
      const summary = buildAnalyticsSection(data, query("summary", scope), NOW);
      const sections = [
        buildAnalyticsSection(data, query("issues", scope), NOW),
        buildAnalyticsSection(data, query("pull-requests", scope), NOW),
        buildAnalyticsSection(data, query("milestones", scope), NOW),
        buildAnalyticsSection(data, query("repository", scope), NOW),
      ];
      assert.deepEqual(summary.metrics, metricIds.map((id) => sections.flatMap((item) => item.metrics).find((item) => item.id === id)));
      assert.deepEqual(summary.charts, chartIds.map((id) => sections.flatMap((item) => item.charts).find((item) => item.id === id)));
      assert.deepEqual(summary.tables, tableIds.map((id) => sections.flatMap((item) => item.tables).find((item) => item.id === id)));
    }
  });

  test("keeps summary Any-role cards, charts, and tables on their attributable families", () => {
    const payload = buildAnalyticsSection(fixture(), query("summary", { person: reviewer.id, role: null }), NOW);
    assert.equal(value(payload, "issues.current.open").value, 1);
    assert.equal(value(payload, "prs.period.opened").value, 0);
    assert.deepEqual(value(payload, "prs.period.opened").detail.ids, []);
    assert.equal(value(payload, "prs.current.review_waiting").value, 1);
    assert.equal(value(payload, "milestones.current.overdue").value, null);
    assert.equal(value(payload, "repository.releases.published").value, null);
    assert.deepEqual(payload.tables.find((item) => item.id === "issues.records")?.rows.map((row) => row._detailIds), ["102"]);
    assert.deepEqual(payload.tables.find((item) => item.id === "prs.records")?.rows.map((row) => row._detailIds), ["210", "211"]);
    const pullActivity = payload.charts.find((item) => item.id === "prs.period.activity");
    assert.ok(pullActivity);
    assert.ok(pullActivity.series.every((series) => series.points.every((item) => item.detail.ids.length === 0)));
  });

  test("does not construct section-only history, detail, or repository outputs for summary", () => {
    const data = fixture();
    Object.defineProperty(data.issues[0]!, "blockedBy", { get() { throw new Error("summary read issue dependencies"); } });
    Object.defineProperty(data.pullRequests[0]!, "changedFiles", { get() { throw new Error("summary read pull details"); } });
    Object.defineProperty(data.repository, "languages", { get() { throw new Error("summary read languages"); } });
    const payload = buildAnalyticsSection(data, query("summary"), NOW);
    assert.deepEqual(payload.metrics.map((item) => item.id), [
      "issues.current.open", "issues.period.opened_events", "issues.period.closed_unique", "issues.current.stale",
      "prs.period.opened", "prs.period.merged", "prs.current.review_waiting", "milestones.current.overdue",
      "repository.releases.published",
    ]);
    assert.deepEqual(payload.charts.map((item) => item.id), ["issues.period.activity", "issues.current.status_distribution", "prs.period.activity", "prs.current.state_distribution"]);
    assert.deepEqual(payload.tables.map((item) => item.id), ["issues.records", "prs.records"]);
  });

  test("keeps repository source semantics and dedupes releases/tags/weeks", () => {
    const payload = buildAnalyticsSection(fixture(), query("repository"), NOW);
    assert.equal(value(payload, "repository.current.languages").value, 1000);
    assert.equal(value(payload, "repository.history.commits").value, 7);
    assert.equal(value(payload, "repository.history.code_frequency").value, 75);
    assert.equal(value(payload, "repository.history.contributors").value, 2);
    assert.equal(value(payload, "repository.releases.published").value, 1);
    assert.equal(value(payload, "repository.releases.interval").value, 31);
    assert.equal(value(payload, "repository.current.latest_release").detail.ids[0], "403");
    assert.equal(value(payload, "repository.current.tags").value, 2);
    const weeks = payload.tables.find((item) => item.id === "repository.commit_weeks");
    assert.ok(weeks);
    assert.deepEqual(new Set(weeks.rows.map((row) => row.source)), new Set(["aggregate", "contributor"]));
  });

  test("filters repository contributor statistics by the bot setting everywhere", () => {
    const data = fixture();
    data.repository.commitWeeks.push(
      { week: "2026-03-15T00:00:00.000Z", source: "contributor", commits: 9, additions: 90, deletions: -30, author: bot },
    );

    const withoutBots = buildAnalyticsSection(data, query("repository"), NOW);
    const withoutBotChart = withoutBots.charts.find((item) => item.id === "repository.history.contributors");
    const withoutBotTable = withoutBots.tables.find((item) => item.id === "repository.commit_weeks");
    assert.ok(withoutBotChart);
    assert.ok(withoutBotTable);
    assert.equal(value(withoutBots, "repository.history.contributors").value, 2);
    assert.ok(withoutBotChart.series[0]!.points.every((item) => item.key !== bot.id));
    assert.ok(withoutBotTable.rows.every((row) => row.author !== "Helper"));
    assert.ok(!analyticsTableCsv(withoutBots, "repository.commit_weeks").includes("Helper"));

    const withBots = buildAnalyticsSection(data, query("repository", { includeBots: true }), NOW);
    const withBotChart = withBots.charts.find((item) => item.id === "repository.history.contributors");
    const withBotTable = withBots.tables.find((item) => item.id === "repository.commit_weeks");
    assert.ok(withBotChart);
    assert.ok(withBotTable);
    assert.equal(value(withBots, "repository.history.contributors").value, 3);
    assert.ok(withBotChart.series[0]!.points.some((item) => item.key === bot.id && item.value === 9));
    assert.ok(withBotTable.rows.some((row) => row.author === "Helper" && row.commits === 9));
    assert.ok(analyticsTableCsv(withBots, "repository.commit_weeks").includes("Helper"));
  });

  test("filters repository weeks by week-start instant and keeps sources distinct", () => {
    const data = fixture();
    data.repository.commitWeeks = [
      { week: "2026-03-18T00:00:00.000Z", source: "aggregate", commits: 100, additions: 100, deletions: -100, author: null },
      { week: "2026-03-18T00:00:00.000Z", source: "contributor", commits: 100, additions: 1_000, deletions: -1_000, author: reviewer },
      { week: "2026-03-25T00:00:00.000Z", source: "aggregate", commits: 3, additions: 7, deletions: -2, author: null },
      { week: "2026-03-25T00:00:00.000Z", source: "contributor", commits: 5, additions: 500, deletions: -50, author: human },
      { week: "2026-04-01T00:00:00.000Z", source: "aggregate", commits: 200, additions: 200, deletions: -200, author: null },
      { week: "2026-04-01T00:00:00.000Z", source: "contributor", commits: 200, additions: 2_000, deletions: -2_000, author: reviewer },
    ];
    const payload = buildAnalyticsSection(data, query("repository", {
      from: "2026-03-25T00:00:00.000Z",
      to: "2026-04-01T00:00:00.000Z",
    }), NOW);
    assert.equal(value(payload, "repository.history.commits").value, 3);
    assert.equal(value(payload, "repository.history.code_frequency").value, 9);
    assert.equal(value(payload, "repository.history.contributors").value, 1);
    const commits = payload.charts.find((item) => item.id === "repository.history.commits");
    const contributors = payload.charts.find((item) => item.id === "repository.history.contributors");
    assert.deepEqual(commits?.series[0]?.points.map((item) => [item.key, item.value]), [["aggregate:2026-03-25T00:00:00.000Z", 3]]);
    assert.deepEqual(contributors?.series[0]?.points.map((item) => [item.key, item.value]), [[human.id, 5]]);
    const weeks = payload.tables.find((item) => item.id === "repository.commit_weeks");
    assert.ok(weeks);
    assert.deepEqual(weeks.rows.map((row) => [row.week, row.source, row.commits]), [
      ["2026-03-25T00:00:00.000Z", "aggregate", 3],
      ["2026-03-25T00:00:00.000Z", "contributor", 5],
    ]);
    const csv = analyticsTableCsv(payload, "repository.commit_weeks");
    assert.ok(csv.includes("2026-03-25T00:00:00.000Z"));
    assert.ok(!csv.includes("2026-03-18T00:00:00.000Z"));
    assert.ok(!csv.includes("2026-04-01T00:00:00.000Z,aggregate"));
  });

  test("keeps only attributable contributor evidence under repository Any filters", () => {
    const anyRole = buildAnalyticsSection(fixture(), query("repository", { person: reviewer.id, role: null }), NOW);
    assert.equal(value(anyRole, "repository.current.languages").value, null);
    assert.equal(value(anyRole, "repository.history.commits").value, null);
    assert.equal(value(anyRole, "repository.history.contributors").value, 1);
    assert.deepEqual(value(anyRole, "repository.history.contributors").detail.ids, [reviewer.id]);
    const contributorChart = anyRole.charts.find((item) => item.id === "repository.history.contributors");
    const languageChart = anyRole.charts.find((item) => item.id === "repository.current.languages");
    const weeks = anyRole.tables.find((item) => item.id === "repository.commit_weeks");
    assert.ok(contributorChart);
    assert.ok(languageChart);
    assert.ok(weeks);
    assert.deepEqual(contributorChart.series[0]?.points.map((item) => item.key), [reviewer.id]);
    assert.ok(languageChart.series.every((series) => series.points.length === 0));
    assert.deepEqual(weeks.rows.map((row) => [row.source, row.author]), [["contributor", "Bob"]]);
    assert.equal(anyRole.tables.find((item) => item.id === "repository.languages")?.rows.length, 0);
    const csv = analyticsTableCsv(anyRole, "repository.commit_weeks");
    assert.ok(csv.includes("Bob"));
    assert.ok(!csv.includes(",aggregate,"));

    const byReviewer = buildAnalyticsSection(fixture(), query("repository", { person: reviewer.id, role: "reviewer" }), NOW);
    assert.equal(value(byReviewer, "repository.history.contributors").sampleSize, 0);
    assert.ok(byReviewer.metrics.every((item) => item.value === null));
    assert.ok(byReviewer.charts.every((item) => item.series.every((series) => series.points.length === 0)));
    assert.ok(byReviewer.tables.every((item) => item.rows.length === 0));
  });

  test("returns every dictionary metric ID with descriptive metadata and truthful details", () => {
    const expected: Record<AnalyticsQuery["section"], string[]> = {
      summary: [],
      issues: ["issues.current.open", "issues.current.in_progress", "issues.current.blocked", "issues.current.unclassified", "issues.period.opened_events", "issues.period.closed_events", "issues.period.closed_unique", "issues.period.completed_unique", "issues.period.closed_not_completed", "issues.period.reopened_events", "issues.period.reopened_unique", "issues.duration.close.median", "issues.duration.close.p75", "issues.duration.cycle.median", "issues.duration.cycle.p75", "issues.current.age", "issues.current.stale", "issues.current.status_distribution", "issues.current.label_distribution", "issues.current.assignee_distribution", "issues.history.status_time", "issues.history.cumulative_flow", "issues.dependencies.waiting", "issues.dependencies.blockers"],
      "pull-requests": ["prs.period.opened", "prs.period.merged", "prs.period.closed_unmerged", "prs.current.state_distribution", "prs.current.review_waiting", "prs.current.changes_requested", "prs.current.checks_distribution", "prs.duration.merge.median", "prs.duration.merge.p75", "prs.duration.first_review.median", "prs.duration.ready_review.median", "prs.duration.ready_merge.median", "prs.reviews.submitted", "prs.reviews.reviewed_unique", "prs.current.request_wait", "prs.current.stale_review", "prs.size.files", "prs.size.lines"],
      contributors: ["people.current.assigned_open", "people.current.in_progress", "people.current.blocked", "people.current.review_requests", "people.period.issues_authored", "people.period.prs_authored", "people.period.prs_merged", "people.period.prs_reviewed", "people.period.reviews_submitted", "people.period.contribution_trend"],
      milestones: ["milestones.current.open", "milestones.current.closed", "milestones.current.overdue", "milestones.current.issue_progress", "milestones.current.pr_progress", "milestones.current.remaining_assignment", "milestones.current.remaining_blocked", "milestones.history.scope", "milestones.history.burnup"],
      repository: ["repository.current.languages", "repository.history.commits", "repository.history.code_frequency", "repository.history.contributors", "repository.releases.published", "repository.releases.interval", "repository.current.latest_release", "repository.current.tags"],
    };
    for (const section of ["issues", "pull-requests", "contributors", "milestones", "repository"] as const) {
      const payload = buildAnalyticsSection(fixture(), query(section), NOW);
      assert.deepEqual(payload.metrics.map((item) => item.id), expected[section]);
      for (const item of payload.metrics) {
        assert.ok(item.calculation.length > 20, item.id);
        assert.ok(item.computedAt.length > 0, item.id);
        assert.ok(item.sampleSize >= 0, item.id);
        assert.ok(item.coverage.length > 0, item.id);
        assert.ok(item.detail.kind.length > 0, item.id);
        if (item.kind === "current") assert.equal(item.period, null, item.id);
        else assert.deepEqual(item.period, payload.period, item.id);
      }
    }
  });

  test("builds deterministic filter options with bot handling", () => {
    const data = fixture();
    const bootstrap = buildAnalyticsBootstrap(data, query("summary"), NOW);
    assert.deepEqual(bootstrap.options.milestones.map((item) => item.number), [1, 2]);
    assert.ok(bootstrap.options.labels.includes("feature"));
    assert.ok(bootstrap.options.people.some((item) => item.id === human.id));
    assert.ok(bootstrap.options.people.every((item) => !item.bot));
    assert.ok(bootstrap.options.timezones.includes("UTC"));
    const withBots = buildAnalyticsBootstrap(data, query("summary", { includeBots: true }), NOW);
    assert.ok(withBots.options.people.some((item) => item.bot));
  });
});

describe("analytics CSV", () => {
  test("exports the exact backing table rows with metadata, RFC 4180 quoting, Unicode, and formula protection", () => {
    const data = fixture();
    data.issues[0]!.title = " =HYPERLINK(\"https://bad\")\r\nZażółć, row";
    const payload = buildAnalyticsSection(data, query("issues"), NOW);
    const csv = analyticsTableCsv(payload, "issues.records");
    assert.ok(csv.includes("# Repository,acme/example"));
    assert.ok(csv.includes("# Metric/table ID,issues.records"));
    assert.ok(csv.includes("# Period to (exclusive),2026-04-01T00:00:00.000Z"));
    assert.ok(csv.includes("\"' =HYPERLINK(\"\"https://bad\"\")\r\nZażółć, row\""));
    assert.equal(csv.endsWith("\r\n"), true);
    assert.equal(csv.includes("\n") && !csv.replaceAll("\r\n", "").includes("\n"), true);
  });

  test("exports chart table alternatives by chart ID with matching totals and protects every formula prefix", () => {
    const payload = buildAnalyticsSection(fixture(), query("repository"), NOW);
    const chart = payload.charts.find((item) => item.id === "repository.current.languages")!;
    const csv = analyticsTableCsv(payload, chart.id);
    assert.ok(csv.includes("Period or group,Bytes"));
    assert.equal(chart.tableRows.reduce((sum, row) => sum + Number(row.bytes), 0), 1000);
    for (const dangerous of ["=1+1", "+cmd", "-2+3", "@SUM(A1)", "  =hidden"]) {
      const changed = structuredClone(payload);
      changed.repository!.languages[0]!.name = dangerous;
      changed.tables.find((item) => item.id === "repository.languages")!.rows[0]!.language = dangerous;
      assert.ok(analyticsTableCsv(changed, "repository.languages").includes(`'${dangerous}`));
    }
    assert.throws(() => analyticsTableCsv(payload, "missing"));
  });
});
