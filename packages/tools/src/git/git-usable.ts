import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
// POSIX on purpose: the only platform this answers anything on is macOS, and
// the host's own `path` would split a Mac PATH on `;` under a Windows test run.
import { posix } from "node:path";

const { join } = posix;

/**
 * Whether `git` can run WITHOUT a system dialog (macOS, 2026-09-23 platform
 * review).
 *
 * On a Mac without Apple's command line developer tools, `/usr/bin/git` is
 * not git: it is a placeholder that answers every invocation by opening the
 * "git requires the command line developer tools — install now?" dialog and
 * exiting 1. The harness runs git on its own — the repository card probes
 * six times on session open, at the end of EVERY turn, on a workspace change
 * and again on a retry, and a brief start probes twice more — so a user who
 * never asked for git (a fan, not a developer, in a folder that is not even a
 * repository) got that dialog back after every reply.
 *
 * `xcode-select -p` answers the question without the dialog: it prints the
 * active developer directory, or fails when there is none. The placeholder
 * forwards to `<that directory>/usr/bin/git`, so git is usable exactly when
 * that file exists — which also covers a stale selection pointing at tools
 * that were since removed.
 *
 * Only the placeholder is checked. A git found earlier on PATH (Homebrew's,
 * Xcode's own, a standalone installer's) is a real binary and runs as-is;
 * off macOS nothing here applies.
 */

export type GitUsability = { ok: true } | { ok: false; message: string };

export interface GitUsableDeps {
  readonly platform: NodeJS.Platform;
  readonly pathEnv: string | undefined;
  /** True for an executable regular file. */
  readonly isExecutable: (path: string) => boolean;
  /** `xcode-select -p`'s answer, or null when it fails. Never opens a dialog. */
  readonly developerDir: () => Promise<string | null>;
  readonly exists: (path: string) => boolean;
  readonly now: () => number;
}

/** Apple's placeholder — the one path that may be a dialog, not a git. */
const APPLE_GIT_SHIM = "/usr/bin/git";

/** How long "unusable" is believed. Short, so a user who installs the tools
 *  from the dialog they saw once gets git back without restarting the app;
 *  the re-check is `xcode-select -p`, which never shows the dialog itself. */
const NEGATIVE_TTL_MS = 30_000;

const XCODE_SELECT_TIMEOUT_MS = 3000;

const UNUSABLE_MESSAGE =
  "git on this Mac is Apple's placeholder: the command line developer tools are not installed (run `xcode-select --install` in Terminal, or install git another way)";

function defaultDeps(): GitUsableDeps {
  return {
    platform: process.platform,
    pathEnv: process.env.PATH,
    isExecutable: (p) => {
      try {
        accessSync(p, constants.X_OK);
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    developerDir: () =>
      new Promise((resolve) => {
        const child = execFile(
          "xcode-select",
          ["-p"],
          { timeout: XCODE_SELECT_TIMEOUT_MS },
          (err, stdout) => {
            const dir = typeof stdout === "string" ? stdout.trim() : "";
            resolve(err === null && dir.length > 0 ? dir : null);
          },
        );
        child.once("error", () => resolve(null));
      }),
    exists: existsSync,
    now: Date.now,
  };
}

/** The first `git` on PATH, the way the spawn will resolve it — or null. */
export function resolveGitOnPath(
  pathEnv: string | undefined,
  isExecutable: (path: string) => boolean,
): string | null {
  for (const dir of (pathEnv ?? "").split(":")) {
    if (dir.length === 0) continue;
    const candidate = join(dir, "git");
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** The uncached decision. Exported for its tests. */
export async function checkGitUsable(
  deps: GitUsableDeps,
): Promise<GitUsability> {
  if (deps.platform !== "darwin") return { ok: true };
  const git = resolveGitOnPath(deps.pathEnv, deps.isExecutable);
  // None at all: the spawn reports ENOENT → "git_not_found" by itself.
  if (git === null || git !== APPLE_GIT_SHIM) return { ok: true };
  const dir = await deps.developerDir().catch(() => null);
  if (dir !== null && deps.exists(join(dir, "usr", "bin", "git"))) {
    return { ok: true };
  }
  return { ok: false, message: UNUSABLE_MESSAGE };
}

let cached: { result: GitUsability; at: number } | null = null;
let inFlight: Promise<GitUsability> | null = null;

/**
 * The cached answer every `spawnGit` asks first. "Usable" is kept for the
 * process lifetime (PATH is fixed at startup); "unusable" for 30 s. Concurrent
 * callers — the probe fires six spawns at once — share one check.
 */
export function gitUsable(
  deps: GitUsableDeps = defaultDeps(),
): Promise<GitUsability> {
  if (deps.platform !== "darwin") return Promise.resolve({ ok: true });
  if (cached !== null) {
    if (cached.result.ok || deps.now() - cached.at < NEGATIVE_TTL_MS) {
      return Promise.resolve(cached.result);
    }
  }
  if (inFlight !== null) return inFlight;
  inFlight = checkGitUsable(deps)
    .then((result) => {
      cached = { result, at: deps.now() };
      return result;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Tests only: forget the cached answer. */
export function resetGitUsableCache(): void {
  cached = null;
  inFlight = null;
}
