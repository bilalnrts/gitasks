export interface TaskIssue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  url: string;
}

export interface IssueUpdate {
  title: string;
  state: "open" | "closed";
  labels: string[];
}

export interface TaskGateway {
  getIssue(issueNumber: number): Promise<TaskIssue>;
  updateIssue(issueNumber: number, update: IssueUpdate): Promise<TaskIssue>;
}
