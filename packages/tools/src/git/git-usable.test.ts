import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkGitUsable,
  type GitUsableDeps,
  gitUsable,
  resetGitUsableCache,
  resolveGitOnPath,
} from "./git-usable.js";

/** A Mac without the command line developer tools: `/usr/bin/git` is Apple's
 *  placeholder and `xcode-select -p` has nothing to report. */
function macDeps(over: Partial<GitUsableDeps> = {}): GitUsableDeps {
  const executables = new Set(["/usr/bin/git"]);
  return {
    platform: "darwin",
    pathEnv: "/usr/bin:/bin:/usr/sbin:/sbin",
    isExecutable: (p) => executables.has(p),
    developerDir: async () => null,
    exists: () => false,
    now: () => 0,
    ...over,
  };
}

afterEach(() => {
  resetGitUsableCache();
});

describe("resolveGitOnPath", () => {
  it("takes the FIRST git on PATH, the way the spawn resolves it", () => {
    const exec = new Set(["/opt/homebrew/bin/git", "/usr/bin/git"]);
    expect(
      resolveGitOnPath("/opt/homebrew/bin:/usr/bin", (p) => exec.has(p)),
    ).toBe("/opt/homebrew/bin/git");
    expect(resolveGitOnPath("/usr/bin", (p) => exec.has(p))).toBe(
      "/usr/bin/git",
    );
    expect(resolveGitOnPath("/nowhere", () => false)).toBeNull();
    expect(resolveGitOnPath(undefined, () => true)).toBeNull();
  });
});

describe("checkGitUsable — the macOS developer-tools placeholder (2026-09-23)", () => {
  it("refuses Apple's placeholder when no developer directory is selected — the dialog is never opened", async () => {
    const r = await checkGitUsable(macDeps());
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.message).toContain("xcode-select --install");
  });

  it("allows the placeholder once the developer tools behind it exist", async () => {
    const r = await checkGitUsable(
      macDeps({
        developerDir: async () => "/Library/Developer/CommandLineTools",
        exists: (p) => p === "/Library/Developer/CommandLineTools/usr/bin/git",
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("refuses a stale selection whose tools were removed", async () => {
    const r = await checkGitUsable(
      macDeps({
        developerDir: async () => "/Library/Developer/CommandLineTools",
        exists: () => false,
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("never asks xcode-select about a real git found earlier on PATH", async () => {
    const developerDir = vi.fn(async () => null);
    const exec = new Set(["/opt/homebrew/bin/git", "/usr/bin/git"]);
    const r = await checkGitUsable(
      macDeps({
        pathEnv: "/opt/homebrew/bin:/usr/bin",
        isExecutable: (p) => exec.has(p),
        developerDir,
      }),
    );
    expect(r.ok).toBe(true);
    expect(developerDir).not.toHaveBeenCalled();
  });

  it("does nothing off macOS", async () => {
    const developerDir = vi.fn(async () => null);
    for (const platform of ["win32", "linux"] as const) {
      expect(
        (await checkGitUsable(macDeps({ platform, developerDir }))).ok,
      ).toBe(true);
    }
    expect(developerDir).not.toHaveBeenCalled();
  });
});

describe("gitUsable — cached, shared, and brief about 'no'", () => {
  it("shares ONE check across concurrent callers (the probe fires six spawns at once)", async () => {
    const developerDir = vi.fn(async () => null);
    const deps = macDeps({ developerDir });
    const all = await Promise.all(
      Array.from({ length: 6 }, () => gitUsable(deps)),
    );
    expect(all.every((r) => !r.ok)).toBe(true);
    expect(developerDir).toHaveBeenCalledTimes(1);
  });

  it("re-checks 'unusable' after 30 s, so tools installed from the dialog count without a restart", async () => {
    let now = 0;
    let installed = false;
    const developerDir = vi.fn(async () =>
      installed ? "/Library/Developer/CommandLineTools" : null,
    );
    const deps = macDeps({
      developerDir,
      exists: () => installed,
      now: () => now,
    });
    expect((await gitUsable(deps)).ok).toBe(false);
    installed = true;
    now = 10_000;
    expect((await gitUsable(deps)).ok).toBe(false); // still believed
    now = 31_000;
    expect((await gitUsable(deps)).ok).toBe(true);
    expect(developerDir).toHaveBeenCalledTimes(2);
  });

  it("keeps 'usable' for the process lifetime", async () => {
    let now = 0;
    const developerDir = vi.fn(
      async () => "/Library/Developer/CommandLineTools",
    );
    const deps = macDeps({ developerDir, exists: () => true, now: () => now });
    expect((await gitUsable(deps)).ok).toBe(true);
    now = 10 * 60_000;
    expect((await gitUsable(deps)).ok).toBe(true);
    expect(developerDir).toHaveBeenCalledTimes(1);
  });
});
