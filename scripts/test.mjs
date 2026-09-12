import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const testDirectory = join(rootDirectory, "test");
const tests = (await readdir(testDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map((entry) => join(testDirectory, entry.name))
  .sort();

if (tests.length === 0) {
  throw new Error("No test/*.test.ts files were found");
}

const child = spawn(
  process.execPath,
  [tsxCli, "--test", ...tests],
  { cwd: rootDirectory, stdio: "inherit" },
);

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal !== null) {
      reject(new Error(`Test process ended with signal ${signal}`));
      return;
    }
    resolve(code ?? 1);
  });
});

process.exitCode = exitCode;
