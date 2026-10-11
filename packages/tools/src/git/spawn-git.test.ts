import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { mkTmpWorkspace } from "../testing/tmp-workspace.js";
import { gitChildEnv, spawnGit } from "./spawn-git.js";

describe("gitChildEnv (platform review 2026-09-23)", () => {
  it("forces git's MESSAGES to English, so 'not a git repository' is still recognised under a Chinese locale — and only its messages", () => {
    const env = gitChildEnv({
      PATH: "/usr/bin",
      LANG: "zh_CN.UTF-8",
      LC_ALL: "zh_CN.UTF-8",
    });
    // LC_MESSAGES wins over LANG; LANGUAGE is what gettext reads when LC_ALL
    // pins a non-C locale (and "en" has no catalogue: the English original).
    expect(env.LC_MESSAGES).toBe("C");
    expect(env.LANGUAGE).toBe("en");
    // The character set stays the user's: paths and commit messages decode
    // exactly as before.
    expect(env.LANG).toBe("zh_CN.UTF-8");
    expect(env.LC_ALL).toBe("zh_CN.UTF-8");
    // …and the prompts stay off.
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_ASKPASS).toBe("");
  });
});

const GIT_AVAILABLE = (() => {
  try {
    const r = spawnSync("git", ["--version"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
})();

// Same file-level timeout as git-status/git-diff, and for the same reason:
// these spawn real git processes, and under full-suite load on Windows the
// multi-spawn cases were measured at 1.7-3.3s against the 5s default — the
// next one armed to flake, so it gets the guard before it does.
describe.skipIf(!GIT_AVAILABLE)("spawnGit", { timeout: 20_000 }, () => {
  // The cap used to drop whichever chunk crossed it and keep appending the
  // ones after, so stdout could be two non-adjacent spans spliced together
  // with nothing saying so — a record garbled at the seam. What survives must
  // be a contiguous PREFIX, and `truncated` must admit it happened.
  it("truncates to a contiguous prefix and reports it", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      await spawnGit(ws.root, ["init", "-q"], new AbortController().signal);
      const full = await spawnGit(
        ws.root,
        ["config", "--list"],
        new AbortController().signal,
      );
      expect(full.ok).toBe(true);
      if (!full.ok) return;
      expect(full.truncated).toBe(false);
      const cut = Math.max(1, Math.floor(full.stdout.length / 2));

      const clipped = await spawnGit(
        ws.root,
        ["config", "--list"],
        new AbortController().signal,
        { maxBufBytes: cut },
      );
      expect(clipped.ok).toBe(true);
      if (!clipped.ok) return;
      expect(clipped.truncated).toBe(true);
      expect(clipped.stdout.length).toBeLessThanOrEqual(cut);
      // The property that matters: a PREFIX, not a splice.
      expect(full.stdout.startsWith(clipped.stdout)).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });

  it("happy path: git status in a fresh repo returns ok", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      await spawnGit(ws.root, ["init", "-q"], new AbortController().signal);
      await spawnGit(
        ws.root,
        ["config", "user.email", "test@example.com"],
        new AbortController().signal,
      );
      await spawnGit(
        ws.root,
        ["config", "user.name", "Test"],
        new AbortController().signal,
      );
      const r = await spawnGit(
        ws.root,
        ["status", "--porcelain=v1", "--branch"],
        new AbortController().signal,
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.stdout).toContain("##");
      }
    } finally {
      await ws.cleanup();
    }
  });

  it("not_a_repo: spawning in a non-repo tmp dir returns code not_a_repo", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      const r = await spawnGit(
        ws.root,
        ["status", "--porcelain=v1"],
        new AbortController().signal,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("not_a_repo");
    } finally {
      await ws.cleanup();
    }
  });

  it("git_failed: invalid ref returns code git_failed with stderr", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      await spawnGit(ws.root, ["init", "-q"], new AbortController().signal);
      const r = await spawnGit(
        ws.root,
        ["diff", "--stat", "no-such-ref-xyz"],
        new AbortController().signal,
      );
      expect(r.ok).toBe(false);
      if (!r.ok && r.code === "git_failed") {
        expect(r.stderr.length).toBeGreaterThan(0);
      } else {
        throw new Error(`expected git_failed, got ${r.ok ? "ok" : r.code}`);
      }
    } finally {
      await ws.cleanup();
    }
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  "spawnGit — the output cap ends the command (ADR 0058 §7.7)",
  { timeout: 20_000 },
  () => {
    it("a writer that never stops is stopped at the cap: its prefix comes back as truncated, well inside the deadline", async () => {
      const ws = await mkTmpWorkspace({});
      try {
        const t0 = Date.now();
        // A git alias that streams forever. Without the cap ending it, the
        // deadline would — and a 250 MB patch would read as a timeout
        // instead of the prefix the viewer can show.
        const r = await spawnGit(
          ws.root,
          ["-c", "alias.spew=!yes herta", "spew"],
          new AbortController().signal,
          { maxBufBytes: 4096, timeoutMs: 5_000 },
        );
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.truncated).toBe(true);
        expect(r.stdout.length).toBeLessThanOrEqual(4096);
        expect(r.stdout.startsWith("herta")).toBe(true);
        expect(Date.now() - t0).toBeLessThan(4_000);
      } finally {
        await ws.cleanup();
      }
    });
  },
);
