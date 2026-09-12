import { GitHubClient } from "./client.js";
import { verifyGitHubAccess } from "./auth.js";
import { detectGitHubRepository } from "./repo.js";
import { runCommand, type CommandRunner } from "../utils/exec.js";

export interface GitHubContext {
  repository: string;
  client: GitHubClient;
}

export async function createGitHubContext(
  cwd = process.cwd(),
  runner: CommandRunner = runCommand,
): Promise<GitHubContext> {
  const repository = await detectGitHubRepository(runner, cwd);
  await verifyGitHubAccess(runner);
  return {
    repository,
    client: new GitHubClient(repository, runner),
  };
}
