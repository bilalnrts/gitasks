import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { CommandError } from "./errors.js";

export interface RunOptions {
  cwd?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<CommandResult>;

const execFileAsync = promisify(execFile);

export const runCommand: CommandRunner = async (file, args, options = {}) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, [...args], {
      ...options,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });

    return { stdout, stderr };
  } catch (error) {
    const commandError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    const causeCode =
      typeof commandError.code === "string" ? commandError.code : undefined;

    throw new CommandError({
      command: [file, ...args].join(" "),
      exitCode: typeof commandError.code === "number" ? commandError.code : null,
      stdout: commandError.stdout ?? "",
      stderr: commandError.stderr ?? "",
      ...(causeCode === undefined ? {} : { causeCode }),
    });
  }
};
