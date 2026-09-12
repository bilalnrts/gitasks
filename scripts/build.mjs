import { chmod, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "tsup";

import { copyUiAssets } from "./copy-ui-assets.mjs";

const rootDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(rootDirectory, "dist");

async function buildCli(stagingDirectory) {
  await build({
    entry: ["src/cli.ts"],
    cwd: rootDirectory,
    outDir: stagingDirectory,
    format: ["esm"],
    platform: "node",
    target: "node20",
    bundle: true,
    splitting: false,
    clean: true,
    minify: true,
    sourcemap: false,
  });

  const cliPath = join(stagingDirectory, "cli.js");
  const cli = await readFile(cliPath, "utf8");
  if (!cli.startsWith("#!/usr/bin/env node\n")) {
    throw new Error("Built CLI is missing its Node.js shebang");
  }
  await chmod(cliPath, 0o755);
}

async function buildUi(stagingDirectory) {
  const uiOutputDirectory = join(stagingDirectory, "ui");
  await build({
    entry: ["src/ui/client/app.ts"],
    cwd: rootDirectory,
    outDir: uiOutputDirectory,
    format: ["iife"],
    platform: "browser",
    target: "es2020",
    globalName: "GitasksUi",
    bundle: true,
    splitting: false,
    clean: true,
    minify: true,
    sourcemap: false,
  });
  await copyUiAssets(join(rootDirectory, "src/ui/client"), uiOutputDirectory);
}

export async function buildRelease() {
  const stagingDirectory = await mkdtemp(join(rootDirectory, ".gitasks-dist-"));
  try {
    await buildCli(stagingDirectory);
    await buildUi(stagingDirectory);
    await rm(outputDirectory, { recursive: true, force: true });
    await rename(stagingDirectory, outputDirectory);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildRelease();
}
