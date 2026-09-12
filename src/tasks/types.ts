export type IssueStateFilter = "open" | "closed" | "all";

export interface TaskIssue {
  id?: number;
  nodeId?: string;
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  url: string;
  body: string;
  createdAt?: string;
  updatedAt?: string;
  author?: { login: string; avatarUrl: string; url: string } | null;
  assignees: string[];
  assigneeUsers?: Array<{ login: string; avatarUrl: string; url: string }>;
  milestone?: {
    number: number;
    title: string;
    description: string;
    state: "open" | "closed";
    dueOn: string | null;
    openIssues: number;
    closedIssues: number;
    url: string;
    updatedAt: string;
  } | null;
}

export interface IssueTransition {
  title: string;
  state: "open" | "closed";
  previousStatusLabels: string[];
  nextStatusLabel: string;
}

export interface CreateIssueInput {
  title: string;
  body: string;
  label: string;
  state: "open" | "closed";
  assignees?: string[];
  milestone?: number | null;
}

export interface TaskCreator {
  createIssue(input: CreateIssueInput): Promise<TaskIssue>;
}

export interface TaskGateway {
  getIssue(issueNumber: number): Promise<TaskIssue>;
  transitionIssue(
    issueNumber: number,
    transition: IssueTransition,
  ): Promise<TaskIssue>;
}
