import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

// A read the clock ends (ADR 0058 §7.7) reports a TIMEOUT — never an empty
// history, an absent commit or an absent diff.
//
// The four readers used to prove this each in their own file by racing the
// REAL git against `timeoutMs: 1`, on the assumption that git always loses.
// On Windows it does (starting a process costs tens of milliseconds). On the
// Linux CI runner git over a one-commit repository sometimes finishes first:
// the timer is armed during one event-loop phase, the child's exit is already
// waiting in the poll phase that comes BEFORE the next timers phase, and the
// read — correctly — succeeds. Scheduled CI went red on exactly that, twice
// (public 2026-09-18, private 2026-09-20; one test, everything else green).
//
// So the clock is no longer raced. The `git` child here never finishes: the
// only thing that can end the read is the deadline, on any machine.
class HangingChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kills = 0;
  kill(): boolean {
    this.kills += 1;
    return true;
  }
}
const spawned: { args: readonly string[]; child: HangingChild }[] = [];
vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((command: string, args: readonly string[], ...rest: unknown[]) => {
      if (command !== "git")
        return (actual.spawn as (...a: unknown[]) => unknown)(
          command,
          args,
          ...rest,
        );
      const child = new HangingChild();
      spawned.push({ args, child });
      return child;
    }) as typeof actual.spawn,
  };
});

import { describeCommit } from "./commit-show.js";
import { describeBranches, describeLog } from "./log-list.js";
import { isGitReadTimeout } from "./spawn-git.js";
import { describeWorkingDiff } from "./working-diff.js";

const dirs: string[] = [];
afterEach(() => {
  spawned.length = 0;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function mkDir(): string {
  const d = mkdtempSync(join(tmpdir(), "git-read-timeout-"));
  dirs.push(d);
  return d;
}

const CLOCK = { timeoutMs: 25 } as const;

/** Every git the reader started was stopped by the clock, once. */
function expectAllStopped(atLeast: number): void {
  expect(spawned.length).toBeGreaterThanOrEqual(atLeast);
  for (const { args, child } of spawned) {
    expect(child.kills, args.join(" ")).toBe(1);
  }
}

describe("git readers — a read the clock ends (ADR 0058 §7.7)", () => {
  it("describeLog reports a timeout, not an empty or absent history", async () => {
    const out = await describeLog(
      mkDir(),
      { skip: 0, limit: 10 },
      undefined,
      CLOCK,
    );
    expect(isGitReadTimeout(out)).toBe(true);
    expectAllStopped(2);
  });

  it("describeBranches reports a timeout, not an empty branch list", async () => {
    const out = await describeBranches(mkDir(), undefined, CLOCK);
    expect(isGitReadTimeout(out)).toBe(true);
    expectAllStopped(1);
  });

  it("describeCommit reports a timeout, not an absent commit", async () => {
    const out = await describeCommit(mkDir(), "a".repeat(40), undefined, CLOCK);
    expect(isGitReadTimeout(out)).toBe(true);
    expectAllStopped(4);
  });

  it("describeWorkingDiff reports a timeout, not an absent diff", async () => {
    const dir = mkDir();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "one\ntwo\n");
    const out = await describeWorkingDiff(dir, "src/a.ts", undefined, CLOCK);
    expect(isGitReadTimeout(out)).toBe(true);
    expectAllStopped(2);
  });

  it("a git that DOES finish inside the clock is an answer, not a timeout", async () => {
    // Anti-vacuous: the fake is what makes the clock win, not the readers
    // answering "timeout" to everything. Let each child exit cleanly as it
    // is started — `for-each-ref` printing nothing is an empty branch list.
    const timer = setInterval(() => {
      for (const { child } of spawned) {
        if (child.listenerCount("close") === 0) continue;
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0);
        child.removeAllListeners("close");
      }
    }, 1);
    try {
      const out = await describeBranches(mkDir(), undefined, {
        timeoutMs: 5_000,
      });
      expect(isGitReadTimeout(out)).toBe(false);
      for (const { child } of spawned) expect(child.kills).toBe(0);
    } finally {
      clearInterval(timer);
    }
  });
});
