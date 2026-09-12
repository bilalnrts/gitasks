import { access, copyFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Try the next output name used by tsup.
    }
  }
  throw new Error(`UI bundle was not created at ${paths.join(" or ")}`);
}

export async function copyUiAssets(sourceDirectory, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });

  const finalBundle = join(outputDirectory, "app.js");
  const builtBundle = await firstExisting([
    join(outputDirectory, "app.global.js"),
    finalBundle,
  ]);
  if (builtBundle !== finalBundle) {
    await rename(builtBundle, finalBundle);
  }

  await Promise.all([
    copyFile(join(sourceDirectory, "index.html"), join(outputDirectory, "index.html")),
    copyFile(join(sourceDirectory, "styles.css"), join(outputDirectory, "styles.css")),
  ]);
}
