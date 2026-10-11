/** Fingerprint frozen source inputs, never runtime profiles or credentials. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(".");
const paths = new Set();
const omitted = new Set(["node_modules", "dist", "out", ".git", ".herta"]);
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (omitted.has(entry.name) || entry.name.startsWith("release")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && !path.endsWith(".tsbuildinfo")) paths.add(path);
  }
}
walk(join(root, "packages"));
walk(join(root, "assets"));
for (const name of [
  "pnpm-lock.yaml",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "LICENSE",
  "THIRD-PARTY-NOTICES.md",
  "docs/ASSET_AUDIT.md",
])
  paths.add(join(root, name));
const files = [...paths].sort().map((path) => ({
  path: relative(root, path).replaceAll("\\", "/"),
  sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
}));
const aggregateSHA256 = createHash("sha256")
  .update(files.map((file) => `${file.path}\0${file.sha256}\n`).join(""))
  .digest("hex");
writeFileSync(
  join(root, "docs/reports/evidence/round-7/final-source-manifest.json"),
  JSON.stringify(
    { version: "0.7.0", uncommitted: true, inputs: files, aggregateSHA256 },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    sourceInputFiles: files.length,
    aggregateSHA256,
    uncommitted: true,
  }),
);
