import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The bash tool runs on the desktop app's MAIN thread: a `spawnSync` there
// freezes the window, the paced reveal and the voice IPC for as long as the
// child takes (perf audit 2026-09-20 — three of them, one per brief start,
// one per brief end, one per first session). This file counts them.
const syncSpawns: string[] = [];
vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: ((...args: Parameters<typeof actual.spawnSync>) => {
      syncSpawns.push(String(args[0]));
      return actual.spawnSync(...args);
    }) as typeof actual.spawnSync,
  };
});

import { removeTmpDir } from "../testing/tmp-workspace.js";
import { findBash } from "./find-bash.js";
import { PersistentShell } from "./persistent-shell.js";
import { primeShellPaths, shellPathsFor } from "./shell-paths.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const BASH = findBash();
const d = describe.skipIf(BASH === null);

d("no synchronous spawn on the bash tool's path (real bash)", () => {
  it("a primed path mapping, a shell's first command, its workspace spelling and its kill spawn nothing synchronously", async () => {
    const bash = BASH as string;
    if (process.platform === "win32") {
      // Anti-vacuous: the counter is live — an UNPRIMED mapping still
      // probes synchronously (a binary that is not there fails at once).
      shellPathsFor(`${bash}.not-there`);
      expect(syncSpawns).toHaveLength(1);
      syncSpawns.length = 0;
    }
    await primeShellPaths(bash);
    // Concurrent and repeated primes share the answer.
    await Promise.all([primeShellPaths(bash), primeShellPaths(bash)]);
    const paths = shellPathsFor(bash);
    expect(shellPathsFor(bash)).toBe(paths);
    if (process.platform === "win32") {
      // The probe's answer made it into the mapping: MSYS `/tmp` is real.
      expect(paths.tmpNative).not.toBeNull();
      expect(paths.toShell(paths.tmpNative as string)).toBe("/tmp");
    }

    const ws = realpathSync(mkdtempSync(join(tmpdir(), "psh-nosync-")));
    const shell = new PersistentShell({ bashPath: bash, workspaceRoot: ws });
    try {
      // The workspace line is protocol: it never shows in a command's output.
      const first = await shell.run("echo hi", { timeoutMs: 10_000 });
      expect(first.output).toBe("hi\n");
      // …and it is how the shell's spelling is known — no second bash.
      const spelled = shell.workspaceShellPath;
      const pwd = await shell.run("pwd", { timeoutMs: 10_000 });
      expect(pwd.output.trim()).toBe(spelled);
    } finally {
      await shell.kill();
      await removeTmpDir(ws);
    }
    expect(shell.isRunning()).toBe(false);
    expect(syncSpawns).toEqual([]);
  });
});
