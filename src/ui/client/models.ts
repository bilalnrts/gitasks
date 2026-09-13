import type {
  ActivityEvent,
  ApiErrorPayload,
  CombinedStatus,
  ListPage,
  MergeMethod,
  MilestoneItems,
  MilestoneSummary,
  OverviewPayload,
  OverviewSection,
  PullRequestDetail,
  PullRequestFile,
  PullRequestReference,
  PullRequestReview,
  PullRequestSummary,
  RepositoryCapabilities,
  TaskDetail,
  TaskSummary,
  UserSummary,
  WorkspaceContext,
} from "../../workspace/types.js";

export type * from "../../analytics/types.js";

export type {
  ActivityEvent,
  ApiErrorPayload,
  CombinedStatus,
  ListPage,
  MergeMethod,
  MilestoneItems,
  MilestoneSummary,
  OverviewPayload,
  OverviewSection,
  PullRequestDetail,
  PullRequestFile,
  PullRequestReference,
  PullRequestReview,
  PullRequestSummary,
  RepositoryCapabilities,
  TaskDetail,
  TaskSummary,
  UserSummary,
  WorkspaceContext,
};

export const WORKFLOW_STATUSES = [
  "BACKLOG",
  "TODO",
  "IN PROGRESS",
  "REVIEW",
  "DONE",
  "BLOCKED",
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export type IssueState = "open" | "closed" | "all";
export type ViewKind = "board" | "list";
export type RouteName = "overview" | "tasks" | "activity" | "pull-requests" | "milestones" | "analytics";

export interface StatusDefinition {
  name: WorkflowStatus;
  slug: string;
  color: string;
}

export interface RepositoryContext extends Partial<WorkspaceContext> {
  repository: string;
  version?: string;
}

export interface PageEnvelope<T> extends ListPage<T> {
  repository?: string;
  state?: string;
  scope?: string;
  statuses?: StatusDefinition[];
  coverage?: string;
  source?: string;
  dateFrom?: string | null;
  dateTo?: string | null;
}

export type MilestoneItemsPayload = MilestoneItems;

export interface BranchSummary {
  name: string;
}

export interface ActivityEnvelope extends PageEnvelope<ActivityEvent> {}
