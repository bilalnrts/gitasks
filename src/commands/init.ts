import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { GitHubClient } from "../github/client.js";
import { TASK_STATUSES } from "../tasks/statuses.js";

const GITASKS_START = "<!-- gitasks:start -->";
const GITASKS_END = "<!-- gitasks:end -->";

export const PROTOCOL_CONTENT = `# Gitasks Task Protocol

GitHub Issues are this repository's task management source of truth. Do not create or maintain a separate task database.

## Rules

- Every development task should have a GitHub Issue.
- Issue titles and labels must follow the Gitasks status protocol.
- Before starting a task, run \`gitasks start <issue-number>\` to move it to \`IN PROGRESS\`.
- When implementation is complete and ready for review, run \`gitasks review <issue-number>\`.
- Move a task to \`DONE\` only when the work is truly complete.
- If progress depends on missing information or an external dependency, run \`gitasks block <issue-number>\`.
- Do not silently change issue status outside this protocol.
- Preserve unrelated issue labels during status changes.
- If an issue has conflicting status labels, its matching title prefix wins; otherwise Gitasks uses the first status in protocol order.
- A filtered list searches open and closed issues. The default unfiltered list shows only active open work.

## Statuses

\`BACKLOG\` → \`TODO\` → \`IN PROGRESS\` → \`REVIEW\` → \`DONE\`

Use \`BLOCKED\` when work cannot continue. A blocked task may return to any active status when its blocker is removed.

## Commands

\`\`\`bash
gitasks list
gitasks create "Describe the task"
gitasks todo 42
gitasks start 42
gitasks review 42
gitasks done 42
gitasks block 42
gitasks backlog 42
\`\`\`

Gitasks synchronizes each issue's \`status:*\` label, title prefix, and open/closed state. GitHub remains authoritative.
`;

export const AGENTS_SECTION = `${GITASKS_START}
## Gitasks Task Management

This repository uses GitHub Issues as its task management source of truth.

Before starting development work:

1. Run \`gitasks list\`.
2. Identify the relevant task.
3. Run \`gitasks start <issue-number>\`.
4. Read \`.gitasks/protocol.md\`.

When implementation is ready for review, run:

\`gitasks review <issue-number>\`

Do not mark tasks as \`DONE\` automatically unless the work is truly complete and doing so is explicitly appropriate. If an external dependency prevents progress, move the task to \`BLOCKED\`.
${GITASKS_END}
`;

async function createFileIfMissing(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

async function updateAgentsFile(path: string): Promise<"created" | "updated" | "unchanged"> {
  let existing: string;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await writeFile(path, `${AGENTS_SECTION}\n`, "utf8");
      return "created";
    }
    throw error;
  }

  if (existing.includes(GITASKS_START)) {
    return "unchanged";
  }

  const separator = existing.length === 0 || existing.endsWith("\n\n")
    ? ""
    : existing.endsWith("\n")
      ? "\n"
      : "\n\n";
  await writeFile(path, `${existing}${separator}${AGENTS_SECTION}\n`, "utf8");
  return "updated";
}

export interface InitResult {
  createdLabels: string[];
  createdFiles: string[];
  updatedFiles: string[];
}

export async function initializeRepository(
  client: Pick<GitHubClient, "ensureStatusLabels">,
  cwd: string,
): Promise<InitResult> {
  const createdLabels = await client.ensureStatusLabels();
  const gitasksDirectory = join(cwd, ".gitasks");
  await mkdir(gitasksDirectory, { recursive: true });

  const config = `${JSON.stringify({ version: 1, statuses: TASK_STATUSES }, null, 2)}\n`;
  const createdFiles: string[] = [];
  if (await createFileIfMissing(join(gitasksDirectory, "config.json"), config)) {
    createdFiles.push(".gitasks/config.json");
  }
  if (
    await createFileIfMissing(
      join(gitasksDirectory, "protocol.md"),
      PROTOCOL_CONTENT,
    )
  ) {
    createdFiles.push(".gitasks/protocol.md");
  }

  const agentsResult = await updateAgentsFile(join(cwd, "AGENTS.md"));
  const updatedFiles: string[] = [];
  if (agentsResult === "created") {
    createdFiles.push("AGENTS.md");
  } else if (agentsResult === "updated") {
    updatedFiles.push("AGENTS.md");
  }

  return { createdLabels, createdFiles, updatedFiles };
}
