import type { ChecksState, MilestoneSummary, ReviewState, UserSummary } from "../workspace/types.js";
import type { TaskStatus } from "../tasks/statuses.js";

export const ANALYTICS_SECTIONS = ["summary", "issues", "pull-requests", "contributors", "milestones", "repository"] as const;
export type AnalyticsSection = (typeof ANALYTICS_SECTIONS)[number];
export type AnalyticsGrouping = "day" | "week" | "month";
export type AnalyticsRole = "author" | "assignee" | "reviewer" | "actor";
export type AnalyticsCoverageState = "complete" | "partial" | "unsupported" | "error" | "pending";
export type AnalyticsMetricKind = "current" | "period-event" | "historical";
export type AnalyticsUnit = "count" | "issues" | "pull-requests" | "reviews" | "people" | "days" | "bytes" | "lines" | "percent";

export interface AnalyticsPeriod {
  from: string;
  to: string;
  timezone: string;
  grouping: AnalyticsGrouping;
  incomplete: boolean;
  previous: { from: string; to: string } | null;
}

export interface AnalyticsFilters {
  milestone: number | null;
  labels: string[];
  person: string | null;
  role: AnalyticsRole | null;
  includeBots: boolean;
  staleDays: number;
  reviewWaitDays: number;
}

export interface AnalyticsQuery extends AnalyticsFilters {
  section: AnalyticsSection;
  from: string;
  to: string;
  timezone: string;
  grouping: AnalyticsGrouping;
  compare: boolean;
}

export interface AnalyticsCoverageSource {
  id: string;
  label: string;
  state: AnalyticsCoverageState;
  loaded: number;
  knownTotal: number | null;
  from: string | null;
  to: string | null;
  fetchedAt: string;
  excluded: number;
  reason: string | null;
  limitations: string[];
}

export interface AnalyticsWarning {
  code: string;
  message: string;
  excluded: number;
  source: string | null;
}

export interface AnalyticsDetailRef {
  kind: "issue" | "issue-event" | "pull-request" | "review" | "person" | "milestone" | "release" | "commit-week";
  ids: string[];
}

export interface AnalyticsMetric {
  id: string;
  label: string;
  value: number | null;
  unit: AnalyticsUnit;
  kind: AnalyticsMetricKind;
  period: AnalyticsPeriod | null;
  computedAt: string;
  sampleSize: number;
  numerator: number | null;
  denominator: number | null;
  previousValue: number | null;
  changePercent: number | null;
  coverage: AnalyticsCoverageState;
  warnings: AnalyticsWarning[];
  detail: AnalyticsDetailRef;
  calculation: string;
  filterBasis: "current-fields" | "event-time" | "record-fields" | "not-applicable";
}

export interface AnalyticsPerson {
  id: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
  url: string | null;
  bot: boolean;
  deleted: boolean;
}

export interface AnalyticsIssue {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  fullTitle: string;
  state: "open" | "closed";
  stateReason: "completed" | "not_planned" | "duplicate" | "reopened" | "unknown";
  status: TaskStatus | null;
  labels: string[];
  statusLabels: string[];
  author: AnalyticsPerson | null;
  assignees: AnalyticsPerson[];
  milestone: MilestoneSummary | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  url: string;
  blockedBy: number[];
  blocking: number[];
}

export interface AnalyticsReview {
  id: number;
  pullNumber: number;
  reviewer: AnalyticsPerson | null;
  state: "approved" | "changes-requested" | "commented" | "dismissed" | "pending" | "unknown";
  submittedAt: string | null;
  commitId: string | null;
  url: string | null;
}

export interface AnalyticsPullRequest {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  mergedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  author: AnalyticsPerson | null;
  assignees: AnalyticsPerson[];
  requestedReviewers: AnalyticsPerson[];
  milestone: MilestoneSummary | null;
  labels: string[];
  requestedTeams: string[];
  reviewState: ReviewState;
  checksState: ChecksState;
  headSha: string;
  changedFiles: number | null;
  additions: number | null;
  deletions: number | null;
  url: string;
}

export type AnalyticsEventType =
  | "opened"
  | "closed"
  | "reopened"
  | "labeled"
  | "unlabeled"
  | "assigned"
  | "unassigned"
  | "milestoned"
  | "demilestoned"
  | "renamed"
  | "review-requested"
  | "review-request-removed"
  | "ready-for-review"
  | "converted-to-draft"
  | "merged"
  | "review-submitted";

export interface AnalyticsEvent {
  id: string;
  subject: "issue" | "pull-request";
  number: number;
  type: AnalyticsEventType;
  createdAt: string;
  actor: AnalyticsPerson | null;
  label: string | null;
  assignee: AnalyticsPerson | null;
  reviewer: AnalyticsPerson | null;
  milestoneTitle: string | null;
  reviewId: number | null;
  reviewState: AnalyticsReview["state"] | null;
  rename: { from: string; to: string } | null;
}

export interface AnalyticsMilestone extends MilestoneSummary {
  createdAt: string;
  closedAt: string | null;
}

export interface AnalyticsRelease {
  id: number;
  tagName: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  createdAt: string;
  publishedAt: string | null;
  url: string;
  author: AnalyticsPerson | null;
}

export interface AnalyticsCommitWeek {
  week: string;
  source: "aggregate" | "contributor";
  commits: number;
  additions: number | null;
  deletions: number | null;
  author: AnalyticsPerson | null;
}

export interface AnalyticsRepository {
  name: string;
  description: string | null;
  visibility: string;
  defaultBranch: string;
  license: string | null;
  url: string;
  languages: Array<{ name: string; bytes: number }>;
  releases: AnalyticsRelease[];
  tags: Array<{ name: string; commitSha: string; url: string }>;
  commitWeeks: AnalyticsCommitWeek[];
}

export interface AnalyticsDataset {
  repository: AnalyticsRepository;
  issues: AnalyticsIssue[];
  pullRequests: AnalyticsPullRequest[];
  reviews: AnalyticsReview[];
  events: AnalyticsEvent[];
  milestones: AnalyticsMilestone[];
  coverage: AnalyticsCoverageSource[];
  fetchedAt: string;
}

export interface AnalyticsSeriesPoint {
  key: string;
  label: string;
  value: number;
  detail: AnalyticsDetailRef;
}

export interface AnalyticsSeries {
  id: string;
  label: string;
  unit: AnalyticsUnit;
  points: AnalyticsSeriesPoint[];
}

export interface AnalyticsChart {
  id: string;
  title: string;
  description: string;
  kind: "line" | "bar" | "stacked-bar" | "distribution";
  unit: AnalyticsUnit;
  series: AnalyticsSeries[];
  coverage: AnalyticsCoverageState;
  warnings: AnalyticsWarning[];
  zeroBaseline: true;
  tableColumns: Array<{ key: string; label: string }>;
  tableRows: Array<Record<string, string | number | null>>;
}

export interface AnalyticsTable {
  id: string;
  title: string;
  description: string;
  columns: Array<{ key: string; label: string; numeric?: boolean }>;
  rows: Array<Record<string, string | number | boolean | null>>;
  total: number;
  scope: string;
  coverage: AnalyticsCoverageState;
  warnings: AnalyticsWarning[];
}

export interface AnalyticsSectionPayload {
  section: AnalyticsSection;
  period: AnalyticsPeriod;
  filters: AnalyticsFilters;
  computedAt: string;
  scope: string;
  metrics: AnalyticsMetric[];
  charts: AnalyticsChart[];
  tables: AnalyticsTable[];
  coverage: AnalyticsCoverageSource[];
  warnings: AnalyticsWarning[];
  repository: AnalyticsRepository | null;
}

export interface AnalyticsFilterOptions {
  milestones: Array<{ number: number; title: string }>;
  labels: string[];
  people: AnalyticsPerson[];
  timezones: string[];
}

export interface AnalyticsBootstrapPayload {
  repository: string;
  computedAt: string;
  defaults: AnalyticsQuery;
  options: AnalyticsFilterOptions;
  current: AnalyticsSectionPayload;
}

export interface AnalyticsGateway {
  loadAnalyticsDataset(scope?: "current" | AnalyticsSection, signal?: AbortSignal, query?: AnalyticsQuery): Promise<AnalyticsDataset>;
}

export interface AnalyticsUserRef extends UserSummary {
  id?: number;
  nodeId?: string;
  type?: string;
}
