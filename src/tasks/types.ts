export interface TaskIssue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  url: string;
}

export interface IssueTransition {
  title: string;
  state: "open" | "closed";
  previousStatusLabels: string[];
  nextStatusLabel: string;
}

export interface TaskGateway {
  getIssue(issueNumber: number): Promise<TaskIssue>;
  transitionIssue(
    issueNumber: number,
    transition: IssueTransition,
  ): Promise<TaskIssue>;
}
