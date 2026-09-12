import type { TaskIssue } from "../tasks/types.js";

export class UserError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "UserError";
    this.exitCode = exitCode;
  }
}

export class PartialCreateError extends UserError {
  readonly issue: TaskIssue;

  constructor(message: string, issue: TaskIssue) {
    super(message);
    this.name = "PartialCreateError";
    this.issue = issue;
  }
}

export class CommandError extends Error {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly causeCode?: string;

  constructor(options: {
    command: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    causeCode?: string;
  }) {
    const detail = options.stderr.trim() || options.stdout.trim();
    super(detail || `Command failed: ${options.command}`);
    this.name = "CommandError";
    this.command = options.command;
    this.exitCode = options.exitCode;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    if (options.causeCode !== undefined) {
      this.causeCode = options.causeCode;
    }
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
