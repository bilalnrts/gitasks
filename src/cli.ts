#!/usr/bin/env node

import { Command } from "commander";

import { createTask } from "./commands/create.js";
import { initializeRepository } from "./commands/init.js";
import { listTasks } from "./commands/list.js";
import { moveTask } from "./commands/transition.js";
import { uiCommand } from "./commands/ui.js";
import { createGitHubContext, type GitHubContext } from "./github/context.js";
import type { TaskStatus } from "./tasks/statuses.js";
import { errorMessage, UserError } from "./utils/errors.js";

const VERSION = "0.4.0";

function print(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function withClient<T>(
  action: (context: GitHubContext) => Promise<T>,
): Promise<T> {
  const context = await createGitHubContext();
  return action(context);
}

function initCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize Gitasks labels and agent protocol files")
    .action(async () => {
      const context = await createGitHubContext();
      const result = await initializeRepository(context.client, process.cwd());
      const lines = [`Initialized Gitasks for ${context.repository}`];
      lines.push(
        result.createdLabels.length > 0
          ? `Created labels: ${result.createdLabels.join(", ")}`
          : "Status labels already exist.",
      );
      if (result.createdFiles.length > 0) {
        lines.push(`Created files: ${result.createdFiles.join(", ")}`);
      }
      if (result.updatedFiles.length > 0) {
        lines.push(`Updated files: ${result.updatedFiles.join(", ")}`);
      }
      if (result.createdFiles.length === 0 && result.updatedFiles.length === 0) {
        lines.push("Protocol files already exist; nothing was overwritten.");
      }
      print(lines.join("\n"));
    });
}

function listCommand(program: Command): void {
  program
    .command("list")
    .description("List GitHub Issues as Gitasks tasks")
    .option(
      "-s, --status <status>",
      "filter by backlog, todo, in-progress, review, done, blocked, or unclassified",
    )
    .option(
      "--state <state>",
      "GitHub issue state: open, closed, or all",
      "open",
    )
    .action(async (options: { status?: string; state: string }) => {
      print(await withClient(({ client }) => listTasks(client, options)));
    });
}

function createCommand(program: Command): void {
  program
    .command("create <title>")
    .description("Create a standardized GitHub Issue task")
    .option("-s, --status <status>", "initial task status", "backlog")
    .option("-b, --body <body>", "issue body", "")
    .action(async (title: string, options: { status: string; body: string }) => {
      print(await withClient(({ client }) => createTask(client, title, options)));
    });
}

function transitionCommands(program: Command): void {
  const commands: ReadonlyArray<{
    command: string;
    status: TaskStatus;
    description: string;
  }> = [
    { command: "backlog", status: "BACKLOG", description: "Move a task to BACKLOG" },
    { command: "todo", status: "TODO", description: "Move a task to TODO" },
    { command: "start", status: "IN PROGRESS", description: "Move a task to IN PROGRESS" },
    { command: "review", status: "REVIEW", description: "Move a task to REVIEW" },
    { command: "done", status: "DONE", description: "Move a task to DONE and close it" },
    { command: "block", status: "BLOCKED", description: "Move a task to BLOCKED" },
  ];

  for (const definition of commands) {
    program
      .command(`${definition.command} <issue>`)
      .description(definition.description)
      .action(async (issue: string) => {
        print(
          await withClient(({ client }) =>
            moveTask(client, issue, definition.status),
          ),
        );
      });
  }
}

async function main(): Promise<void> {
  const program = new Command()
    .name("gitasks")
    .description(
      "Lightweight task management for humans and coding agents, powered by GitHub Issues",
    )
    .version(VERSION)
    .showHelpAfterError();

  initCommand(program);
  listCommand(program);
  createCommand(program);
  transitionCommands(program);
  uiCommand(program);

  await program.parseAsync(process.argv);
}

try {
  await main();
} catch (error) {
  if (error instanceof UserError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode;
  } else {
    process.stderr.write(`Unexpected error: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
