import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { abortError, errorMessage, isAbortError } from "@herta/core";
import { childProcessEnv } from "../child-env.js";
import { gitUsable } from "./git-usable.js";

export interface SpawnGitOk {
  ok: true;
  stdout: string;
  /** The exit code, for callers that allow a non-zero one. */
  exitCode: number;
  /** Output hit the capture cap, so `stdout` is a PREFIX of what git said.
   *  A caller reporting a file list must say so rather than present the
   *  prefix as the whole answer. */
  truncated: boolean;
}

export type SpawnGitErr =
  | { ok: false; code: "not_a_repo"; message: string }
  | {
      ok: false;
      code: "git_failed";
      message: string;
      exitCode: number | null;
      stderr: string;
    }
  | { ok: false; code: "git_timeout"; message: string }
  | {
      ok: false;
      code: "spawn_failed";
      message: string;
      /** Why the spawn failed, so callers stop guessing. Node reports a
       *  missing BINARY and a missing CWD with the same ENOENT, and both tools
       *  used to render either as "git is not on PATH" — telling a user whose
       *  subst/network workspace had vanished to install software they already
       *  have (the failure mode `39e55e5` already cost this repo once). */
      cause: "git_not_found" | "workspace_missing" | "other";
    };

export interface SpawnGitOpts {
  /** Milliseconds before the child is killed. git blocks indefinitely on a
   *  credential prompt or an unreachable remote, and callers include a
   *  permission RULE that runs on the Electron main process — an unbounded
   *  wait there is a frozen app. */
  timeoutMs?: number;
  /** Exit codes to accept besides 0. Several git queries use a non-zero exit
   *  as an ANSWER (`--no-index` returns 1 for "there were differences"), which
   *  is not a failure. */
  allowExitCodes?: readonly number[];
  /** Capture cap per stream, in bytes. Exists so the truncation behaviour can
   *  be exercised without producing four megabytes of git output. */
  maxBufBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Config a REPOSITORY can set to make an otherwise read-only git command
 * execute an arbitrary program, neutralised on every invocation.
 *
 * These are `-c` options and must precede the subcommand. Note that git takes
 * the LAST occurrence of a repeated `-c`, so this is defence in depth rather
 * than the primary guard: the primary guard is that no caller and no model
 * input reaches this position at all (a model-supplied `ref` lands in the
 * subcommand's operand position, where `-c` is not a config option).
 */
const HARDENED_CONFIG: readonly string[] = [
  "-c",
  "core.pager=cat",
  "-c",
  "diff.external=",
  "-c",
  "core.quotePath=false",
];

/** Prepend the config hardening to a subcommand argv. */
export function hardenedGitArgs(args: readonly string[]): string[] {
  return [...HARDENED_CONFIG, ...args];
}

const MAX_BUF = 4 * 1024 * 1024;

/**
 * A read the clock ended (ADR 0058 §7.7): the answer is UNKNOWN, not absent.
 * The viewer's readers return this instead of null when any of their spawns
 * hit `git_timeout`, so a `--grep` over a huge history reads as "timed out;
 * try again" rather than "not found". One frozen instance, compared by
 * identity, so it crosses package boundaries without a class.
 */
export interface GitReadTimeout {
  readonly timedOut: true;
}
export const GIT_READ_TIMEOUT: GitReadTimeout = Object.freeze({
  timedOut: true as const,
});
export function isGitReadTimeout(value: unknown): value is GitReadTimeout {
  return value === GIT_READ_TIMEOUT;
}
/** Whether any of a reader's spawns was ended by the clock. */
export function anyTimedOut(
  results: readonly (SpawnGitOk | SpawnGitErr)[],
): boolean {
  return results.some((r) => !r.ok && r.code === "git_timeout");
}

export async function spawnGit(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  opts: SpawnGitOpts = {},
): Promise<SpawnGitOk | SpawnGitErr> {
  // Already cancelled before we spawn — never report that as a git problem.
  if (signal.aborted) throw abortError();
  // On a Mac without the developer tools, `/usr/bin/git` is a dialog, not a
  // git (see git-usable.ts): answer "no git" instead of opening it. Every
  // harness git call comes through here, so this is the one place it holds.
  const usable = await gitUsable();
  if (!usable.ok) {
    return {
      ok: false,
      code: "spawn_failed",
      cause: "git_not_found",
      message: usable.message,
    };
  }
  return spawnGitProcess(cwd, args, signal, opts);
}

/**
 * The environment every harness git call runs with.
 *
 * git's MESSAGES are forced to English (platform review 2026-09-23): the
 * harness reads git's stderr — "not a git repository" is how a folder
 * without a repository is told from a failure — and a git localized by the
 * user's locale (`LANG=zh_CN.UTF-8`, or Git for Windows following a
 * Chinese Windows) said 不是 git 仓库, so the repository card read a plain
 * folder as a transient failure. Only messages: `LC_MESSAGES` for a locale
 * without `LC_ALL`, `LANGUAGE` for one with it (gettext honours LANGUAGE
 * whenever the locale is not C). The character set, and therefore how paths
 * and commit messages decode, stays the user's. `run_command` git is the
 * user's own and keeps their language.
 */
export function gitChildEnv(
  base: NodeJS.ProcessEnv = childProcessEnv(),
): NodeJS.ProcessEnv {
  return {
    ...base,
    LC_MESSAGES: "C",
    LANGUAGE: "en",
    GIT_OPTIONAL_LOCKS: "0",
    // A credential helper or an askpass dialog blocks the child forever, and
    // on Windows that is a real shape (a private remote plus the manager
    // helper). With the timeout below this bounds the wait; on its own it
    // usually avoids one entirely.
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
  };
}

function spawnGitProcess(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  opts: SpawnGitOpts,
): Promise<SpawnGitOk | SpawnGitErr> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowed = new Set([0, ...(opts.allowExitCodes ?? [])]);
  const maxBuf = opts.maxBufBytes ?? MAX_BUF;
  return new Promise((resolve, reject) => {
    // Already cancelled before we spawn — never report that as a git problem.
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", args, {
        cwd,
        signal,
        shell: false,
        env: gitChildEnv(),
      });
    } catch (err) {
      resolve({
        ok: false,
        code: "spawn_failed",
        message: errorMessage(err),
        cause: existsSync(cwd) ? "other" : "workspace_missing",
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let resolved = false;
    let truncated = false;
    /** The cap is the answer (ADR 0058 §7.7): once stdout has filled it,
     *  the writer is stopped and the prefix returned at once — a 250 MB
     *  patch used to run on to the deadline and read as a timeout, and a
     *  grandchild holding the pipe (an alias shelling out) would never let
     *  `close` fire at all, so the streams are destroyed here too. The exit
     *  code is unknowable for a process we ended; a prefix marked
     *  `truncated` is what the callers read. */
    const stopAtCap = (): void => {
      if (resolved) return;
      truncated = true;
      try {
        child.kill();
      } catch {
        // already gone
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle({
        ok: true,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        exitCode: 0,
        truncated: true,
      });
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: SpawnGitOk | SpawnGitErr): void => {
      if (resolved) return;
      resolved = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      if (resolved) return;
      try {
        child.kill();
      } catch {
        // already gone
      }
      settle({
        ok: false,
        code: "git_timeout",
        message: `git did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped (args: ${args.slice(0, 3).join(" ")}…)`,
      });
    }, timeoutMs);
    timer.unref?.();
    /** An interrupt is NOT a tool failure (audit 2026-07-24, 1.8). Node emits
     *  the same `error` event with an AbortError when the spawn signal fires,
     *  so the old catch-all turned a user's Stop into
     *  `{code:"spawn_failed"}` — which the callers render as the fabricated
     *  "git is not on PATH", append to the backend transcript, and feed to the
     *  model as working history. Because the tool RESOLVED, the turn loop
     *  never classified the turn as interrupted either. Rejecting propagates
     *  the cancellation exactly as `run_command` does. */
    const settleAborted = (): void => {
      if (resolved) return;
      resolved = true;
      if (timer !== undefined) clearTimeout(timer);
      reject(abortError());
    };

    // Stop AT the cap rather than skipping whichever chunk happens to cross
    // it. Dropping only the oversized chunk and continuing to append the
    // smaller ones after it spliced two non-adjacent spans together, so the
    // record at the seam was a half of one path glued to a half of another —
    // and nothing said so. Truncated output is now a contiguous prefix, and
    // `truncated` says it happened; the parsers read NUL-delimited records, so
    // a prefix loses whole records instead of corrupting one.
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutLen >= maxBuf) {
        // A chunk landed exactly on the cap and more followed: over it.
        stopAtCap();
        return;
      }
      const room = maxBuf - stdoutLen;
      const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
      stdoutChunks.push(kept);
      stdoutLen += kept.length;
      if (kept.length < chunk.length) stopAtCap();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrLen >= maxBuf) return;
      const room = maxBuf - stderrLen;
      const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
      if (kept.length < chunk.length) truncated = true;
      stderrChunks.push(kept);
      stderrLen += kept.length;
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      // Checked FIRST: an abort surfaces here as a plain `error` event, and
      // the ENOENT arm below would otherwise be the only branch that even
      // looked at `code` — everything else fell through to spawn_failed.
      if (signal.aborted || isAbortError(err)) {
        settleAborted();
        return;
      }
      if (err.code === "ENOENT") {
        // Node uses ENOENT for BOTH a missing binary and a missing cwd. Ask
        // which one it was rather than guessing, so a vanished workspace stops
        // being reported as "install git".
        const missingCwd = !existsSync(cwd);
        settle({
          ok: false,
          code: "spawn_failed",
          cause: missingCwd ? "workspace_missing" : "git_not_found",
          message: missingCwd
            ? `the workspace directory no longer exists: ${cwd}`
            : "git binary not found on PATH",
        });
        return;
      }
      settle({
        ok: false,
        code: "spawn_failed",
        cause: "other",
        message: err.message,
      });
    });

    child.on("close", (code) => {
      // A kill-by-signal from the abort closes the child with a null/non-zero
      // code and no stderr; without this it read as `git_failed`.
      if (signal.aborted) {
        settleAborted();
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== null && allowed.has(code)) {
        settle({ ok: true, stdout, exitCode: code, truncated });
        return;
      }
      if (code === 128 && /not a git repository/i.test(stderr)) {
        settle({
          ok: false,
          code: "not_a_repo",
          message: stderr.trim() || "not a git repository",
        });
        return;
      }
      settle({
        ok: false,
        code: "git_failed",
        message: stderr.trim() || `git exited with code ${code}`,
        exitCode: code,
        stderr,
      });
    });
  });
}
