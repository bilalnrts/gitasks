import { once } from "node:events";

import type { Command } from "commander";

import { createGitHubContext, type GitHubContext } from "../github/context.js";
import {
  DEFAULT_UI_PORT,
  parseUiPort,
  startUiServer,
} from "../ui/server.js";

export { DEFAULT_UI_PORT, parseUiPort };

export async function runUiCommand(
  context: GitHubContext,
  portInput: string,
  write: (message: string) => void,
): Promise<void> {
  const port = parseUiPort(portInput);
  const running = await startUiServer({
    repository: context.repository,
    gateway: context.client,
    port,
  });
  write(`Gitasks UI running at ${running.url}`);
  write(`Repository: ${context.repository}`);
  write("Press Ctrl+C to stop.");

  const closed = once(running.server, "close");
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    write("Stopping Gitasks UI...");
    void running.close();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await closed;
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }
}

export function uiCommand(program: Command): void {
  program
    .command("ui")
    .description("Start the local Gitasks task board")
    .option("-p, --port <port>", "local server port", String(DEFAULT_UI_PORT))
    .action(async (options: { port: string }) => {
      const context = await createGitHubContext();
      await runUiCommand(context, options.port, (message) => {
        process.stdout.write(`${message}\n`);
      });
    });
}
