import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { buildRelease } from "./build.mjs";

const VERSION = "0.5.0";
const rootDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedFiles = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "docs/analytics-metrics.md",
  "SECURITY.md",
  "dist/cli.js",
  "dist/ui/app.js",
  "dist/ui/index.html",
  "dist/ui/styles.css",
  "package.json",
].sort();

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? rootDirectory,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(
        `${command} ${args.join(" ")} failed${signal === null ? ` with exit code ${code}` : ` with signal ${signal}`}\n${stderr || stdout}`,
      ));
    });
  });
}

function runNpm(args, options = {}) {
  if (process.env.npm_execpath !== undefined) {
    return run(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    ...options,
    shell: process.platform === "win32",
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address === "object", "Could not reserve a UI smoke-test port");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return port;
}

async function makeFakeGh(directory, repositoryDirectory) {
  if (process.platform === "win32") {
    await copyFile(process.execPath, join(directory, "gh.exe"));
    await writeFile(join(repositoryDirectory, "auth"), "process.exitCode = 0;\n", "utf8");
    return;
  }
  const executable = join(directory, "gh");
  await writeFile(executable, "#!/usr/bin/env node\nprocess.exitCode = 0;\n", "utf8");
  await chmod(executable, 0o755);
}

async function request(url) {
  const response = await fetch(url);
  const body = await response.text();
  assert(response.status === 200, `${url} returned HTTP ${response.status}`);
  assert(body.length > 0, `${url} returned an empty body`);
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function smokeUi(cliPath, repositoryDirectory, environment, port) {
  const child = spawn(process.execPath, [cliPath, "ui", "--port", String(port)], {
    cwd: repositoryDirectory,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        child.stdout.on("data", () => {
          if (stdout.includes(`Gitasks UI running at http://127.0.0.1:${port}`)) {
            resolve();
          }
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => reject(new Error(
          `Installed UI exited before startup${signal === null ? ` with exit code ${code}` : ` with signal ${signal}`}\n${stderr || stdout}`,
        )));
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Installed UI did not start within 10 seconds\n${stderr || stdout}`)), 10_000)),
    ]);

    const baseUrl = `http://127.0.0.1:${port}`;
    for (const path of ["/", "/overview", "/tasks", "/activity", "/pull-requests", "/milestones", "/app.js", "/styles.css"]) {
      await request(`${baseUrl}${path}`);
    }
  } finally {
    await stopProcess(child);
  }
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "gitasks-package-"));
try {
  const packageJson = JSON.parse(await readFile(join(rootDirectory, "package.json"), "utf8"));
  assert(packageJson.version === VERSION, `package.json version must be ${VERSION}`);

  await buildRelease();
  const builtCli = await readFile(join(rootDirectory, "dist/cli.js"), "utf8");
  assert(builtCli.startsWith("#!/usr/bin/env node\n"), "Built CLI is missing its Node.js shebang");

  const packed = await runNpm([
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    temporaryDirectory,
  ]);
  const packResults = JSON.parse(packed.stdout);
  assert(Array.isArray(packResults) && packResults.length === 1, "npm pack did not report exactly one tarball");
  const packResult = packResults[0];
  assert(packResult.version === VERSION, `Tarball version must be ${VERSION}`);

  const actualFiles = packResult.files.map((file) => file.path).sort();
  assert(
    JSON.stringify(actualFiles) === JSON.stringify(expectedFiles),
    `Tarball allowlist mismatch\nExpected: ${expectedFiles.join(", ")}\nActual: ${actualFiles.join(", ")}`,
  );
  for (const requiredUiFile of ["dist/ui/app.js", "dist/ui/index.html", "dist/ui/styles.css"]) {
    assert(actualFiles.includes(requiredUiFile), `Tarball is missing ${requiredUiFile}`);
  }
  const cliEntry = packResult.files.find((file) => file.path === "dist/cli.js");
  if (process.platform !== "win32") {
    assert(cliEntry !== undefined && (cliEntry.mode & 0o111) !== 0, "Tarball CLI is not executable");
  }

  const installDirectory = join(temporaryDirectory, "installed");
  await mkdir(installDirectory);
  await writeFile(join(installDirectory, "package.json"), "{\"private\":true}\n", "utf8");
  const tarballPath = join(temporaryDirectory, packResult.filename);
  await runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], {
    cwd: installDirectory,
  });

  const installedCli = join(installDirectory, "node_modules", "gitasks", "dist", "cli.js");
  const installedSource = await readFile(installedCli, "utf8");
  assert(installedSource.startsWith("#!/usr/bin/env node\n"), "Installed CLI is missing its Node.js shebang");
  const version = await run(process.execPath, [installedCli, "--version"], { cwd: installDirectory });
  assert(version.stdout.trim() === VERSION, `Installed CLI reported ${version.stdout.trim()} instead of ${VERSION}`);
  const help = await run(process.execPath, [installedCli, "--help"], { cwd: installDirectory });
  assert(help.stdout.includes("Usage: gitasks"), "Installed CLI help is unavailable");
  const executable = await runNpm(["exec", "--", "gitasks", "--version"], { cwd: installDirectory });
  assert(executable.stdout.trim() === VERSION, `Installed npm binary reported ${executable.stdout.trim()} instead of ${VERSION}`);

  await run("git", ["init", installDirectory]);
  await run("git", ["remote", "add", "origin", "https://github.com/example/gitasks-smoke.git"], { cwd: installDirectory });
  const fakeBin = join(temporaryDirectory, "fake-bin");
  await mkdir(fakeBin);
  await makeFakeGh(fakeBin, installDirectory);
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const environment = {
    ...process.env,
    [pathKey]: `${fakeBin}${delimiter}${process.env[pathKey] ?? ""}`,
  };
  await smokeUi(installedCli, installDirectory, environment, await reservePort());

  process.stdout.write(`Verified gitasks-${VERSION} tarball (${actualFiles.length} files)\n`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
