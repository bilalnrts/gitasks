import type { CommandRunner } from "../utils/exec.js";
import { CommandError, UserError } from "../utils/errors.js";

export function parseGitHubRemote(remote: string): string | undefined {
  const value = remote.trim();
  const patterns = [
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return `${match[1]}/${match[2]}`;
    }
  }

  return undefined;
}

export async function detectGitHubRepository(
  runner: CommandRunner,
  cwd = process.cwd(),
): Promise<string> {
  try {
    const { stdout } = await runner("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
    });
    if (stdout.trim() !== "true") {
      throw new UserError("Not inside a git repository.");
    }
  } catch (error) {
    if (error instanceof UserError) {
      throw error;
    }
    if (error instanceof CommandError && error.causeCode === "ENOENT") {
      throw new UserError("Git is not installed or is not available on PATH.");
    }
    throw new UserError("Not inside a git repository.");
  }

  let remote: string;
  try {
    remote = (await runner("git", ["remote", "get-url", "origin"], { cwd })).stdout;
  } catch {
    throw new UserError(
      "No origin remote found.\n\nAdd a GitHub remote, for example:\ngit remote add origin https://github.com/owner/repo.git",
    );
  }

  const repository = parseGitHubRemote(remote);
  if (repository === undefined) {
    throw new UserError(
      `The origin remote is not a supported GitHub URL:\n${remote.trim()}\n\nExpected an HTTPS or SSH github.com remote.`,
    );
  }

  return repository;
}
