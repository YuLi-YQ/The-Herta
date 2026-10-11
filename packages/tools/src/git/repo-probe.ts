import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  RepoContextDirtyFile,
  RepoContextSnapshot,
  RepoInProgressState,
  RepoRecentCommit,
  RepoSnapshot,
} from "@herta/core";
import { unpushedShas } from "./log-list.js";
import { parseStatusPorcelainZ } from "./parse-status.js";
import { hardenedGitArgs, type SpawnGitErr, spawnGit } from "./spawn-git.js";

/**
 * The workspace's VCS state at one instant — HEAD plus every path that differs
 * from it.
 *
 * Feeds `CodingAgentRuntime`'s dispatch baseline (taken at brief start and
 * again at brief end). It lives here, not in core, because it needs git and
 * `@herta/tools` already depends on core — importing the other way would close
 * a cycle. The runtime takes it as an injected callback.
 *
 * Returns null rather than throwing for every "cannot tell" case — no repo, no
 * git, a timeout, an unreadable tree, a cancelled dispatch. Attribution is a
 * nicety; it must never be able to fail a brief. A null at either end simply
 * leaves the report with the editors' own harvest, exactly as before this
 * existed.
 *
 * The guard is HERE and not only at the caller, because `spawnGit` REJECTS on
 * abort — correctly, since an interrupt is not a tool failure — so a user's
 * Stop landing mid-probe threw straight through this function's stated
 * contract. One caller happened to wrap it; the invariant should not depend on
 * that.
 */
export async function probeRepoState(
  workspaceRoot: string,
  signal?: AbortSignal,
  scope: { workspaceOnly?: boolean } = {},
): Promise<RepoSnapshot | null> {
  try {
    return await probe(workspaceRoot, signal, scope.workspaceOnly === true);
  } catch {
    return null;
  }
}

/** One file a committed range touched. Mirrors core's `RepoRangeFile`. */
export interface RangeChangedFile {
  readonly path: string;
  readonly kind: "created" | "modified" | "deleted";
}

/** Both ends come from OUR OWN `rev-parse HEAD`, but the guard costs nothing
 *  and keeps this function safe to call with anything: a non-hex "head"
 *  never reaches a git argv. */
const COMMIT_ID = /^[0-9a-f]{4,64}$/;

/**
 * The files the committed range `fromHead..toHead` touched — the dispatch
 * baseline's second half (2026-08-26). Answers ONLY when `toHead` DESCENDS
 * from `fromHead` (this dispatch committed or merged forward, so the range
 * is its own work); a rebase/amend/reset — where the old head is no longer
 * an ancestor — returns null and the runtime keeps its honest refusal note.
 *
 * `--no-renames` on purpose: a rename reports as delete + create, which is
 * exactly what happened to the tree, and spares the parser the Rxxx
 * old\0new shape. Same null-not-throw contract as `probeRepoState`.
 */
export async function diffCommittedRange(
  workspaceRoot: string,
  fromHead: string,
  toHead: string,
  signal?: AbortSignal,
  scope: { workspaceOnly?: boolean } = {},
): Promise<readonly RangeChangedFile[] | null> {
  try {
    return await rangeDiff(
      workspaceRoot,
      fromHead,
      toHead,
      signal,
      scope.workspaceOnly === true,
    );
  } catch {
    return null;
  }
}

async function rangeDiff(
  workspaceRoot: string,
  fromHead: string,
  toHead: string,
  signal?: AbortSignal,
  workspaceOnly = false,
): Promise<readonly RangeChangedFile[] | null> {
  if (!COMMIT_ID.test(fromHead) || !COMMIT_ID.test(toHead)) return null;
  const sig = signal ?? new AbortController().signal;
  const opts = { timeoutMs: 5_000 } as const;

  // Exit 1 is an ANSWER (not an ancestor → not attributable), not a failure.
  const ancestor = await spawnGit(
    workspaceRoot,
    hardenedGitArgs(["merge-base", "--is-ancestor", fromHead, toHead]),
    sig,
    { ...opts, allowExitCodes: [1] },
  );
  if (!ancestor.ok || ancestor.exitCode !== 0) return null;

  const diff = await spawnGit(
    workspaceRoot,
    hardenedGitArgs([
      "diff",
      "--name-status",
      "-z",
      "--no-renames",
      fromHead,
      toHead,
      "--",
      ...(workspaceOnly ? ["."] : []),
    ]),
    sig,
    opts,
  );
  if (!diff.ok) return null;

  const fields = diff.stdout.split("\0");
  const out: RangeChangedFile[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i] ?? "";
    const path = fields[i + 1] ?? "";
    if (status.length === 0 || path.length === 0) continue;
    out.push({
      path,
      kind:
        status[0] === "A"
          ? "created"
          : status[0] === "D"
            ? "deleted"
            : "modified",
    });
  }
  if (!workspaceOnly) return out;
  const prefix = await workspaceGitPrefix(workspaceRoot, sig);
  if (prefix === null) return null;
  return out.flatMap((file) => {
    const path = scopedRepoPath(file.path, prefix);
    return path === null ? [] : [{ ...file, path }];
  });
}

/** Git porcelain paths are repo-relative even when cwd is a selected subproject. */
export async function workspaceGitPrefix(
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await spawnGit(
    workspaceRoot,
    hardenedGitArgs(["rev-parse", "--show-prefix"]),
    signal ?? new AbortController().signal,
    { timeoutMs: 5000 },
  );
  return result.ok ? result.stdout.replace(/\r?\n$/, "") : null;
}
export function scopedRepoPath(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const scoped = path.slice(prefix.length);
  return scoped && !scoped.startsWith("../") && !scoped.startsWith("/")
    ? scoped
    : null;
}

/**
 * Locate the git dir governing `startDir` without spawning git: walk up
 * looking for `.git` — a directory IS the git dir; a file (worktree,
 * submodule) points at it via `gitdir: <path>`. Null when no repo, on any
 * fs error, or on a malformed `.git` file. Sync and cheap on purpose: the
 * shell classifier calls this at ask time (ADR 0049 §5), where a spawn
 * per ask is not acceptable.
 */
export function resolveGitDir(startDir: string): string | null {
  try {
    let dir = resolve(startDir);
    for (;;) {
      const dotGit = join(dir, ".git");
      if (existsSync(dotGit)) {
        const st = statSync(dotGit);
        if (st.isDirectory()) return dotGit;
        if (st.isFile()) {
          const text = readFileSync(dotGit, "utf8");
          const m = /^gitdir:\s*(.+)\s*$/m.exec(text);
          if (m?.[1] === undefined) return null;
          const target = m[1].trim();
          return isAbsolute(target) ? target : resolve(dir, target);
        }
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

/**
 * Which operation the repo at `gitDir` is in the middle of, from the
 * transient files git itself keys on — existence checks only, no spawn
 * (per-worktree state lives in the resolved git dir, so a linked worktree
 * answers for itself). Rebase is checked first: a conflicted rebase stop
 * can also leave e.g. CHERRY_PICK_HEAD around, and "rebase" is the answer
 * a person would give. Null when nothing is mid-flight or on fs errors.
 */
export function detectInProgressState(
  gitDir: string,
): RepoInProgressState | null {
  try {
    if (
      existsSync(join(gitDir, "rebase-merge")) ||
      existsSync(join(gitDir, "rebase-apply"))
    )
      return "rebase";
    if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge";
    if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
    if (existsSync(join(gitDir, "REVERT_HEAD"))) return "revert";
    if (existsSync(join(gitDir, "BISECT_LOG"))) return "bisect";
    return null;
  } catch {
    return null;
  }
}

/** Unmerged porcelain XY pairs — the conflict set for the snapshot. */
function isUnmerged(x: string, y: string): boolean {
  return (
    x === "U" ||
    y === "U" ||
    (x === "A" && y === "A") ||
    (x === "D" && y === "D")
  );
}

/** Bounds for the snapshot's lists — the prompt section must stay small;
 *  `dirtyTotal` keeps the honest count for the truncation line. */
const MAX_CONTEXT_DIRTY = 40;
const MAX_CONTEXT_CONFLICTED = 20;
const MAX_SUBJECT_CHARS = 120;
/** The card's recent-commit list (ADR 0058 §5.4). The backend frame keeps
 *  its own tighter bound (`renderRepoContext`) — prompt bytes and rail
 *  rows are different budgets. */
export const MAX_RECENT_SUBJECTS = 10;
/** Unit separator between the log record's fields (never in a subject). */
const LOG_FIELD = "\x1f";

/**
 * The richer repo description the backend frame renders as its repo-snapshot
 * section (ADR 0049 §§1–2): branch, upstream ±counts, default branch,
 * in-progress state, conflict set, bounded dirty list, recent subjects.
 *
 * Same contract as {@link probeRepoState}: null (never a throw) for every
 * "cannot tell" case — prompt context is a nicety and must not fail a brief.
 * Runs once per dispatch at brief start, beside the baseline probe.
 */
export async function describeRepoContext(
  workspaceRoot: string,
  signal?: AbortSignal,
  scope: { workspaceOnly?: boolean } = {},
): Promise<RepoContextSnapshot | null> {
  const out = await describeRepoOutcome(workspaceRoot, signal, scope);
  return out.kind === "repo" ? out.repo : null;
}

/** Why a probe could not answer, when the reason is not "no repository". */
export type RepoProbeTransientReason =
  | "git_timeout"
  | "git_failed"
  | "spawn_failed"
  | "aborted";

/**
 * The card's probe answer (ADR 0058 §7.6). `absent` is definite — no
 * repository here, no git, no such directory — and retracts the card;
 * `transient` is a probe that could not answer THIS time (a `git status`
 * past its budget during the rebase the user is watching, a command that
 * failed on a lock, an interrupt) and says nothing about the repository,
 * so the caller keeps what it last knew.
 */
export type RepoContextOutcome =
  | { readonly kind: "repo"; readonly repo: RepoContextSnapshot }
  | { readonly kind: "absent" }
  | { readonly kind: "transient"; readonly reason: RepoProbeTransientReason };

/** Whether a failed git spawn is a definite "not a repository" or a passing
 *  condition. Exported for its tests. */
export function classifyProbeFailure(err: SpawnGitErr): "absent" | "transient" {
  if (err.code === "not_a_repo") return "absent";
  if (err.code === "spawn_failed" && err.cause !== "other") return "absent";
  return "transient";
}

function transientReason(err: SpawnGitErr): RepoProbeTransientReason {
  if (err.code === "git_timeout") return "git_timeout";
  if (err.code === "git_failed") return "git_failed";
  return "spawn_failed";
}

/** Never throws: an abort is a transient answer, like every other reason
 *  the probe could not finish. */
export async function describeRepoOutcome(
  workspaceRoot: string,
  signal?: AbortSignal,
  scope: { workspaceOnly?: boolean } = {},
): Promise<RepoContextOutcome> {
  try {
    return await describe(workspaceRoot, signal, scope.workspaceOnly === true);
  } catch {
    return { kind: "transient", reason: "aborted" };
  }
}

async function describe(
  workspaceRoot: string,
  signal?: AbortSignal,
  workspaceOnly = false,
): Promise<RepoContextOutcome> {
  const sig = signal ?? new AbortController().signal;
  const opts = { timeoutMs: 5_000 } as const;

  // All six queries are independent; `log` on an unborn HEAD exits 128,
  // which is an answer (no commits → no subjects), not a failure — so the
  // whole set can run concurrently.
  const [head, status, log, originHead, layout, marks] = await Promise.all([
    spawnGit(
      workspaceRoot,
      hardenedGitArgs(["rev-parse", "--short", "HEAD"]),
      sig,
      { ...opts, allowExitCodes: [128] },
    ),
    spawnGit(
      workspaceRoot,
      hardenedGitArgs([
        "status",
        "--porcelain=v1",
        "-z",
        "--branch",
        "--untracked-files=all",
        ...(workspaceOnly ? ["--no-renames", "--", "."] : []),
      ]),
      sig,
      opts,
    ),
    // Structured, NUL-terminated records rather than `--oneline`: the card
    // draws id, subject and an unpushed mark apart (ADR 0058 §5.4/§5.6),
    // and the frame's text form is derived from the same fields — one
    // spawn, no decoration to strip.
    spawnGit(
      workspaceRoot,
      hardenedGitArgs([
        "log",
        "-z",
        `--format=%H${LOG_FIELD}%h${LOG_FIELD}%s`,
        "-n",
        String(MAX_RECENT_SUBJECTS),
        "HEAD",
        "--",
        ...(workspaceOnly ? ["."] : []),
      ]),
      sig,
      { ...opts, allowExitCodes: [128] },
    ),
    // Exit 1 = origin/HEAD is simply unset (fresh remote, no clone default).
    spawnGit(
      workspaceRoot,
      hardenedGitArgs([
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
      ]),
      sig,
      { ...opts, allowExitCodes: [1] },
    ),
    // Where the workspace sits in its repository (ADR 0058 amendment,
    // 2026-09-07): the top level, and the workspace's path inside it —
    // "" at the root, `packages/gui/` (trailing slash) below it.
    spawnGit(
      workspaceRoot,
      hardenedGitArgs(["rev-parse", "--show-toplevel", "--show-prefix"]),
      sig,
      opts,
    ),
    // Which of the recent commits are not on the upstream yet (ADR 0058
    // §5.6) — the rev-list set, so a merge cannot mislabel the list.
    unpushedShas(workspaceRoot, sig, opts.timeoutMs),
  ]);
  // A definite "not a repository" from any of the three wins over a passing
  // failure in another: `rm -rf .git` is an answer even while a lock stalls.
  const failed = [head, status, layout].filter((r) => !r.ok);
  if (failed.some((r) => !r.ok && classifyProbeFailure(r) === "absent")) {
    return { kind: "absent" };
  }
  const first = failed[0];
  if (first !== undefined && !first.ok) {
    return { kind: "transient", reason: transientReason(first) };
  }
  if (!head.ok || !status.ok || !layout.ok) return { kind: "absent" };
  const [root = "", prefix = ""] = layout.stdout.split(/\r?\n/);
  if (root.length === 0) return { kind: "absent" };

  const parsed = parseStatusPorcelainZ(status.stdout);
  const scopedFiles = workspaceOnly
    ? parsed.files.filter((file) => scopedRepoPath(file.path, prefix) !== null)
    : parsed.files;
  const shortSha = head.stdout.trim();
  const headShort =
    head.exitCode === 0 && shortSha.length > 0 ? shortSha : null;

  const dirty: RepoContextDirtyFile[] = [];
  const conflicted: string[] = [];
  for (const f of scopedFiles) {
    if (dirty.length < MAX_CONTEXT_DIRTY) {
      dirty.push({ x: f.indexStatus, y: f.worktreeStatus, path: f.path });
    }
    if (
      conflicted.length < MAX_CONTEXT_CONFLICTED &&
      isUnmerged(f.indexStatus, f.worktreeStatus)
    ) {
      conflicted.push(f.path);
    }
  }

  const recentCommits: RepoRecentCommit[] = [];
  if (log.ok && log.exitCode === 0) {
    for (const rec of log.stdout.split("\0")) {
      if (rec.length === 0 || recentCommits.length >= MAX_RECENT_SUBJECTS)
        continue;
      const [sha = "", shortSha = "", ...rest] = rec.split(LOG_FIELD);
      if (sha.length === 0 || shortSha.length === 0) continue;
      const subject = rest.join(LOG_FIELD);
      recentCommits.push({
        sha,
        shortSha,
        subject:
          subject.length > MAX_SUBJECT_CHARS
            ? `${subject.slice(0, MAX_SUBJECT_CHARS)}…`
            : subject,
        // A gone upstream publishes nothing: every commit is unpushed.
        unpushed: parsed.upstreamGone || marks.shas.has(sha),
      });
    }
  }
  // The frame's text form, unchanged in shape from the `--oneline` days.
  const recentSubjects = recentCommits.map((c) => `${c.shortSha} ${c.subject}`);

  // `--short` yields "origin/main"; the branch name is what the model wants.
  let defaultBranch: string | null = null;
  if (originHead.ok && originHead.exitCode === 0) {
    const ref = originHead.stdout.trim();
    const slash = ref.indexOf("/");
    if (slash > 0 && slash < ref.length - 1)
      defaultBranch = ref.slice(slash + 1);
  }

  const gitDir = resolveGitDir(workspaceRoot);
  const inProgress = gitDir !== null ? detectInProgressState(gitDir) : null;

  const repo: RepoContextSnapshot = {
    root,
    prefix,
    gitDir,
    branch: parsed.branch,
    detached: parsed.branch === null && headShort !== null,
    headShort,
    upstream: parsed.upstream ?? null,
    upstreamGone: parsed.upstreamGone,
    ahead: parsed.ahead,
    behind: parsed.behind,
    defaultBranch,
    inProgress,
    conflicted,
    dirty,
    dirtyTotal: scopedFiles.length,
    recentSubjects,
    recentCommits,
  };
  return { kind: "repo", repo };
}

async function probe(
  workspaceRoot: string,
  signal?: AbortSignal,
  workspaceOnly = false,
): Promise<RepoSnapshot | null> {
  const sig = signal ?? new AbortController().signal;
  // A short budget on purpose: this runs twice per dispatch, and a slow answer
  // is worth less than a fast brief.
  const opts = { timeoutMs: 5_000 } as const;

  // Together, not one after the other (perf audit 2026-09-20): neither read
  // needs the other's answer, this runs at the start AND the end of every
  // dispatch, and a process start is the expensive part on Windows. It also
  // puts the two observations closer to the same instant. Outside a
  // repository both fail and the answer is `null`, exactly as before.
  const [head, status] = await Promise.all([
    spawnGit(
      workspaceRoot,
      hardenedGitArgs(["rev-parse", "HEAD"]),
      sig,
      // An unborn branch exits 128 with "unknown revision"; that is an ANSWER
      // (no commits yet), not a failure.
      { ...opts, allowExitCodes: [128] },
    ),
    spawnGit(
      workspaceRoot,
      hardenedGitArgs([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        ...(workspaceOnly ? ["--no-renames", "--", "."] : []),
      ]),
      sig,
      opts,
    ),
  ]);
  if (!head.ok || !status.ok) return null;

  const parsed = parseStatusPorcelainZ(status.stdout);
  const prefix = workspaceOnly
    ? await workspaceGitPrefix(workspaceRoot, sig)
    : "";
  if (prefix === null) return null;
  const dirty: string[] = [];
  for (const f of parsed.files) {
    const path = workspaceOnly ? scopedRepoPath(f.path, prefix) : f.path;
    if (path === null) continue;
    dirty.push(path);
    // A rename shows the NEW path; the OLD one is gone from the tree and is
    // just as much a change.
    if (f.origPath !== undefined) {
      const original = workspaceOnly
        ? scopedRepoPath(f.origPath, prefix)
        : f.origPath;
      if (original !== null) dirty.push(original);
    }
  }
  const sha = head.stdout.trim();
  return {
    head: head.exitCode === 0 && sha.length > 0 ? sha : null,
    dirty,
  };
}
