import type { TaskStatus } from "../tasks/statuses.js";

export interface UserSummary {
  login: string;
  avatarUrl: string;
  url: string;
}

export interface MilestoneSummary {
  number: number;
  title: string;
  description: string;
  state: "open" | "closed";
  dueOn: string | null;
  openIssues: number;
  closedIssues: number;
  url: string;
  updatedAt: string;
}

export interface TaskSummary {
  id: number;
  nodeId: string;
  number: number;
  status: TaskStatus | null;
  fullTitle: string;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  url: string;
  createdAt: string;
  updatedAt: string;
  author: UserSummary | null;
  assignees: UserSummary[];
  milestone: MilestoneSummary | null;
  relationCount?: number;
  linkedPullRequestCount?: number;
}

export interface PullRequestReference {
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  mergedAt: string | null;
  url: string;
}

export interface TaskDetail {
  task: TaskSummary;
  parent: TaskSummary | null;
  subIssues: TaskSummary[];
  blockedBy: TaskSummary[];
  blocking: TaskSummary[];
  linkedPullRequests: PullRequestReference[];
}

export type ReviewState =
  | "approved"
  | "changes-requested"
  | "review-required"
  | "pending"
  | "unknown";
export type ChecksState = "success" | "failure" | "pending" | "neutral" | "unknown";

export interface PullRequestSummary {
  number: number;
  nodeId: string;
  title: string;
  body: string;
  state: "open" | "closed";
  draft: boolean;
  mergedAt: string | null;
  author: UserSummary | null;
  assignees: UserSummary[];
  milestone: MilestoneSummary | null;
  labels: string[];
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  reviewState: ReviewState;
  checksState: ChecksState;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface PullRequestReview {
  id: number;
  nodeId: string;
  user: UserSummary | null;
  body: string;
  state: string;
  submittedAt: string | null;
  url: string;
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string | null;
  blobUrl: string;
}

export interface PullRequestFileCoverage {
  complete: boolean;
  loaded: number;
  knownTotal: number | null;
  limit: number;
}

export interface CheckRunSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CombinedStatus {
  state: string;
  totalCount: number;
  statuses: Array<{
    id: number;
    context: string;
    state: string;
    description: string | null;
    targetUrl: string | null;
  }>;
  checkRuns: CheckRunSummary[];
  complete: boolean;
}

export type MergeMethod = "merge" | "squash" | "rebase";

export interface PullRequestDetail {
  pullRequest: PullRequestSummary;
  requestedReviewers: UserSummary[];
  reviews: PullRequestReview[];
  files: PullRequestFile[];
  fileCoverage: PullRequestFileCoverage;
  combinedStatus: CombinedStatus;
  mergeable: boolean | null;
  mergeableState: string;
  allowedMergeMethods: MergeMethod[];
  linkedIssues: TaskSummary[];
}

export interface ActivityEvent {
  id: string;
  type: string;
  actor: UserSummary | null;
  subject: {
    kind: "issue" | "pull-request";
    number: number;
    title: string;
    url: string;
  };
  action: string;
  createdAt: string;
}

export interface ListPage<T> {
  items: T[];
  hasNext: boolean;
  complete: boolean;
  nextPage: number | null;
  knownTotal: number | null;
}

export interface ApiErrorPayload {
  error: string;
  code: string;
  retryable: boolean;
  stateVerified: boolean;
  permission?: string;
  unsupported?: string;
  repair?: Record<string, unknown>;
}

export interface RepositoryCapabilities {
  issues: boolean;
  pullRequests: boolean;
  mergeMethods: MergeMethod[];
  permissions: {
    push: boolean;
    triage: boolean;
    maintain: boolean;
    admin: boolean;
  };
}

export interface WorkspaceContext {
  repository: string;
  repositoryUrl: string;
  currentUser: UserSummary;
  capabilities: RepositoryCapabilities;
}

export interface MilestoneItems {
  issues: TaskSummary[];
  pullRequests: PullRequestSummary[];
  complete: boolean;
}

export interface OverviewSection<T> {
  available: boolean;
  data: T | null;
  error: ApiErrorPayload | null;
}

export interface OverviewPayload {
  openIssues: OverviewSection<number>;
  inProgressIssues: OverviewSection<number>;
  blockedIssues: OverviewSection<number>;
  openPullRequests: OverviewSection<number>;
  assignedToMe: OverviewSection<TaskSummary[]>;
  upcomingMilestones: OverviewSection<MilestoneSummary[]>;
  recentlyUpdated: OverviewSection<Array<TaskSummary | PullRequestSummary>>;
}
