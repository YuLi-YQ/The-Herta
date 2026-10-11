import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Counts the stats the listing makes: it used to stat EVERY entry, serially
// (perf audit 2026-09-20). Directory entries carry their own type now, so a
// stat is for links only.
const stats: string[] = [];
const dirsRead: string[] = [];
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: ((...args: Parameters<typeof actual.stat>) => {
      stats.push(String(args[0]));
      return actual.stat(...args);
    }) as typeof actual.stat,
    readdir: ((...args: unknown[]) => {
      dirsRead.push(String(args[0]));
      return (actual.readdir as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.readdir,
  };
});

import { removeTmpDir } from "../testing/tmp-workspace.js";
import { listDirectory, MAX_OUTPUT_CHARS } from "./engine.js";

const dirs: string[] = [];
afterEach(async () => {
  stats.length = 0;
  dirsRead.length = 0;
  for (const d of dirs.splice(0)) await removeTmpDir(d);
});
function mk(): string {
  const d = mkdtempSync(join(tmpdir(), "sre-list-"));
  dirs.push(d);
  return d;
}

describe("listDirectory", () => {
  it("lists two levels by name, marks directories, skips hidden / node_modules / __pycache__ — and stats nothing to do it", async () => {
    const root = mk();
    mkdirSync(join(root, "src", "deep", "deeper"), { recursive: true });
    mkdirSync(join(root, "node_modules", "x"), { recursive: true });
    mkdirSync(join(root, "__pycache__"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "b.txt"), "");
    writeFileSync(join(root, "a.txt"), "");
    writeFileSync(join(root, ".env"), "");
    writeFileSync(join(root, "src", "z.ts"), "");
    writeFileSync(join(root, "src", "deep", "hidden-by-depth.ts"), "");
    const out = await listDirectory(root, "/ws");
    const rows = out.split("\n").filter((l) => /^[df]\t/.test(l));
    expect(rows).toEqual([
      "d\t/ws",
      "f\t/ws/a.txt",
      "f\t/ws/b.txt",
      "d\t/ws/src",
      "d\t/ws/src/deep", // listed, not entered: two levels
      "f\t/ws/src/z.ts",
    ]);
    expect(stats).toEqual([]);
  });

  it("a link is what it points at; a broken one is skipped — the only entries that cost a stat", async () => {
    const root = mk();
    mkdirSync(join(root, "real"));
    writeFileSync(join(root, "real", "inside.txt"), "");
    try {
      // "junction" needs no admin on Windows; ignored on POSIX.
      symlinkSync(join(root, "real"), join(root, "link"), "junction");
      symlinkSync(join(root, "gone"), join(root, "broken"), "junction");
    } catch {
      return; // environment cannot create directory links; skip
    }
    const out = await listDirectory(root, "/ws");
    const rows = out.split("\n").filter((l) => /^[df]\t/.test(l));
    expect(rows).toEqual([
      "d\t/ws",
      "d\t/ws/link",
      "f\t/ws/link/inside.txt",
      "d\t/ws/real",
      "f\t/ws/real/inside.txt",
    ]);
    expect(stats).toHaveLength(2); // the two links, nothing else
  });

  it("stops walking once the clip budget is spent — what cannot be shown is not read", async () => {
    const root = mk();
    // Two big sibling directories: the first alone overflows the budget, so
    // the second must never be entered.
    for (const dir of ["a-first", "b-second"]) {
      mkdirSync(join(root, dir));
      for (let i = 0; i < 1200; i += 1)
        writeFileSync(
          join(root, dir, `file-${String(i).padStart(5, "0")}.txt`),
          "",
        );
    }
    dirsRead.length = 0;
    const out = await listDirectory(root, "/ws");
    expect(out).toContain("<response clipped>");
    expect(out).toContain("/ws/a-first/file-00000.txt");
    // The proof is in what was READ, not in what is shown (the clip hides
    // the rest either way): the root and the first directory, never the
    // second. It used to read — and stat — all 2 400 files.
    expect(dirsRead.map((d) => d.split(/[\\/]/).pop())).toEqual([
      root.split(/[\\/]/).pop(),
      "a-first",
    ]);
    expect(stats).toEqual([]);
    expect(out.length).toBeLessThan(MAX_OUTPUT_CHARS + 600);
  }, 60_000);
});
