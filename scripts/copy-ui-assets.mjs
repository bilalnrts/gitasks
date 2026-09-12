import { copyFile, mkdir, rename } from "node:fs/promises";

await mkdir("dist/ui", { recursive: true });
await rename("dist/ui/app.global.js", "dist/ui/app.js");
await Promise.all([
  copyFile("src/ui/client/index.html", "dist/ui/index.html"),
  copyFile("src/ui/client/styles.css", "dist/ui/styles.css"),
]);
