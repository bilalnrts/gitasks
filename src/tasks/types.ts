export interface TaskIssue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  url: string;
  body: string;
  assignees: string[];
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
