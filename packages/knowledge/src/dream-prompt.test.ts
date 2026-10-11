import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as entry from "./dream-prompt.js";

const SRC = dirname(fileURLToPath(import.meta.url));

/** Every module reachable from `file` through static imports / re-exports:
 *  relative ones are followed, bare specifiers are collected. */
function walk(file: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const visit = (f: string): void => {
    if (files.has(f)) return;
    files.add(f);
    const text = readFileSync(f, "utf8");
    // `import type` / `export type` lines are erased at compile time: they
    // cost nothing at run time and must not count against the entry.
    const re =
      /^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;
    for (const m of text.matchAll(re)) {
      const spec = m[1] ?? m[2];
      if (spec === undefined) continue;
      if (!spec.startsWith(".")) {
        bare.add(spec);
        continue;
      }
      const target = resolve(dirname(f), spec.replace(/\.js$/, ".ts"));
      if (existsSync(target)) visit(target);
    }
  };
  visit(file);
  return { files, bare };
}

describe("@herta/knowledge/dream-prompt — the narrow entry stays narrow", () => {
  it("exports exactly what the runtime wiring reads", () => {
    expect(Object.keys(entry).sort()).toEqual(
      ["readManifest", "resolveDreamConfig", "selectPromptExclusions"].sort(),
    );
  });

  it("reaches nothing outside dream/, and none of the package's heavy dependencies", () => {
    // The package ROOT costs ~550 ms to import cold (ingest, voice tooling,
    // the SQLite store and its native addon); this entry ~80 ms. Every host
    // loads it at boot, and the CLI is not bundled — so what it can reach is
    // a startup budget, not a style preference (measured 2026-09-21).
    const { files, bare } = walk(join(SRC, "dream-prompt.ts"));
    const outside = [...files]
      .map((f) => relative(SRC, f).replace(/\\/g, "/"))
      .filter((f) => f !== "dream-prompt.ts" && !f.startsWith("dream/"));
    expect(outside).toEqual([]);
    for (const heavy of ["better-sqlite3", "linkedom", "zod", "@herta/herta"]) {
      expect([...bare], `reaches ${heavy}`).not.toContain(heavy);
    }
    // Anti-vacuous: the walker really follows imports — the ROOT does reach
    // the store, so the same walk over it must find what this entry avoids.
    expect([...walk(join(SRC, "index.ts")).bare]).toContain("better-sqlite3");
    expect(files.size).toBeGreaterThan(3);
  });
});
