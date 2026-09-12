import type { CommandRunner } from "../utils/exec.js";
import { CommandError, UserError } from "../utils/errors.js";

export async function verifyGitHubCli(runner: CommandRunner): Promise<void> {
  try {
    await runner("gh", ["--version"]);
  } catch (error) {
    if (error instanceof CommandError && error.causeCode === "ENOENT") {
      throw new UserError(
        "GitHub CLI is not installed.\n\nInstall it from:\nhttps://cli.github.com/",
      );
    }
    throw new UserError(
      "GitHub CLI could not be executed.\n\nInstall or repair it using:\nhttps://cli.github.com/",
    );
  }
}

export async function verifyGitHubAuthentication(
  runner: CommandRunner,
): Promise<void> {
  try {
    await runner("gh", ["auth", "status", "--hostname", "github.com"]);
  } catch {
    throw new UserError(
      "GitHub authentication not found.\n\nRun:\ngh auth login",
    );
  }
}

export async function verifyGitHubAccess(runner: CommandRunner): Promise<void> {
  await verifyGitHubCli(runner);
  await verifyGitHubAuthentication(runner);
}
