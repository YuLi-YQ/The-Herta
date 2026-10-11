import { describe, expect, it } from "vitest";
import { parseStatusPorcelain, parseStatusPorcelainZ } from "./parse-status.js";

describe("parseStatusPorcelain", () => {
  it("returns clean state when only branch line present", () => {
    const r = parseStatusPorcelain("## main\n");
    expect(r.branch).toBe("main");
    expect(r.ahead).toBe(0);
    expect(r.behind).toBe(0);
    expect(r.files).toEqual([]);
    expect(r.clean).toBe(true);
  });

  it("parses upstream tracking with ahead+behind counts", () => {
    const r = parseStatusPorcelain(
      "## main...origin/main [ahead 2, behind 1]\n",
    );
    expect(r.branch).toBe("main");
    expect(r.ahead).toBe(2);
    expect(r.behind).toBe(1);
  });

  it("parses ahead-only tracking", () => {
    const r = parseStatusPorcelain("## feature...origin/main [ahead 5]\n");
    expect(r.ahead).toBe(5);
    expect(r.behind).toBe(0);
  });

  it("returns null branch for detached HEAD", () => {
    const r = parseStatusPorcelain("## HEAD (no branch)\n");
    expect(r.branch).toBeNull();
  });

  it("parses modified files (worktree status)", () => {
    const r = parseStatusPorcelain("## main\n M src/x.ts\n");
    expect(r.clean).toBe(false);
    expect(r.files).toEqual([
      { path: "src/x.ts", indexStatus: " ", worktreeStatus: "M" },
    ]);
  });

  it("parses staged + unstaged combo", () => {
    const r = parseStatusPorcelain(
      "## main\nMM src/a.ts\nA  src/b.ts\n D src/c.ts\n",
    );
    expect(r.files).toEqual([
      { path: "src/a.ts", indexStatus: "M", worktreeStatus: "M" },
      { path: "src/b.ts", indexStatus: "A", worktreeStatus: " " },
      { path: "src/c.ts", indexStatus: " ", worktreeStatus: "D" },
    ]);
  });

  it("parses untracked files", () => {
    const r = parseStatusPorcelain("## main\n?? new.txt\n");
    expect(r.files).toEqual([
      { path: "new.txt", indexStatus: "?", worktreeStatus: "?" },
    ]);
  });

  it("parses renames with origPath", () => {
    const r = parseStatusPorcelain("## main\nR  old.ts -> new.ts\n");
    expect(r.files).toEqual([
      {
        path: "new.ts",
        indexStatus: "R",
        worktreeStatus: " ",
        origPath: "old.ts",
      },
    ]);
  });
});

/**
 * `-z` because the default `core.quotePath` C-quotes any non-ASCII name — a
 * Chinese filename arrived as thirty characters of octal that no tool could
 * open, for the audience this product is primarily built for.
 */
describe("parseStatusPorcelainZ — machine format (2026-08-25)", () => {
  it("keeps a non-ASCII path raw", () => {
    const r = parseStatusPorcelainZ("## main\0?? 中文note.md\0");
    expect(r.files).toEqual([
      { path: "中文note.md", indexStatus: "?", worktreeStatus: "?" },
    ]);
  });

  it("an unborn HEAD is a branch name, not the sentence git printed", () => {
    // `## No commits yet on main` was sliced like a normal header and yielded
    // the whole sentence as `branch`.
    expect(parseStatusPorcelainZ("## No commits yet on main\0").branch).toBe(
      "main",
    );
    expect(
      parseStatusPorcelainZ("## No commits yet on main...origin/main\0").branch,
    ).toBe("main");
  });

  it("a rename is NEW then OLD here — the OPPOSITE of diff --numstat -z", () => {
    const r = parseStatusPorcelainZ("## main\0R  new.ts\0old.ts\0");
    expect(r.files).toEqual([
      {
        path: "new.ts",
        indexStatus: "R",
        worktreeStatus: " ",
        origPath: "old.ts",
      },
    ]);
  });

  it("still reads branch, ahead/behind and detached HEAD", () => {
    const r = parseStatusPorcelainZ(
      "## main...origin/main [ahead 2, behind 3]\0 M a.ts\0",
    );
    expect(r.branch).toBe("main");
    expect(r.ahead).toBe(2);
    expect(r.behind).toBe(3);
    expect(r.clean).toBe(false);
    expect(parseStatusPorcelainZ("## HEAD (no branch)\0").branch).toBeNull();
  });

  it("a path containing a newline survives, which the line format could not represent", () => {
    const r = parseStatusPorcelainZ("## main\0?? we\nird.txt\0");
    expect(r.files[0]?.path).toBe("we\nird.txt");
  });

  it("keeps the upstream NAME, with tracking info and in-sync alike (ADR 0049)", () => {
    expect(
      parseStatusPorcelainZ("## main...origin/main [ahead 2]\0").upstream,
    ).toBe("origin/main");
    expect(parseStatusPorcelainZ("## main...origin/main\0").upstream).toBe(
      "origin/main",
    );
    expect(parseStatusPorcelainZ("## main\0").upstream).toBeUndefined();
    expect(
      parseStatusPorcelainZ("## HEAD (no branch)\0").upstream,
    ).toBeUndefined();
  });
});

describe("parseStatusPorcelainZ — a gone upstream (ADR 0058 §7)", () => {
  it("names the upstream and says it is gone; the counts stay 0 because git cannot measure against it", () => {
    const r = parseStatusPorcelainZ("## main...origin/main [gone]\0");
    expect(r.branch).toBe("main");
    expect(r.upstream).toBe("origin/main");
    expect(r.upstreamGone).toBe(true);
    expect(r.ahead).toBe(0);
    expect(r.behind).toBe(0);
  });

  it("a live upstream is not gone", () => {
    const r = parseStatusPorcelainZ("## main...origin/main [ahead 2]\0");
    expect(r.upstreamGone).toBe(false);
    expect(parseStatusPorcelainZ("## main\0").upstreamGone).toBe(false);
  });
});
