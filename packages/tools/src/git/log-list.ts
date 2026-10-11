import type { GitReadOptions } from "./commit-show.js";
import {
  anyTimedOut,
  GIT_READ_TIMEOUT,
  type GitReadTimeout,
  hardenedGitArgs,
  spawnGit,
} from "./spawn-git.js";

/**
 * A page of the repository's history for the viewer's log tab (ADR 0059
 * §6): a ref's `git log`, newest first, with each commit marked UNPUSHED
 * when it is not yet on that ref's upstream — the set
 * `rev-list <ref>@{upstream}..<ref>` names, not a guess from the ahead
 * count and the list's order (a merge can interleave them).
 *
 * `skip` / `limit` page it; one extra row is asked for so `hasMore` is a
 * fact, not an inference from a full page. `ref` picks whose history
 * (default HEAD — read-only: nothing here checks anything out), `query`
 * filters by commit message (case-insensitive, a fixed string). Same
 * null-never-throw contract as the other readers.
 */
export interface LogEntry {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly author: string;
  /** ISO 8601 author date. */
  readonly authoredAt: string;
  /** Not on the ref's tracked upstream yet (false when there is none). */
  readonly unpushed: boolean;
}

export interface LogPage {
  readonly entries: readonly LogEntry[];
  readonly skip: number;
  /** More history lies past this page. */
  readonly hasMore: boolean;
  /** The upstream the marks are measured against, or null when unset. */
  readonly upstream: string | null;
  /** The upstream is set but gone (deleted on the remote): every entry is
   *  unpushed, whatever the marks could measure (ADR 0058 §7). */
  readonly upstreamGone: boolean;
}

export interface LogQuery {
  readonly skip: number;
  readonly limit: number;
  /** A branch or other ref name; absent = HEAD. */
  readonly ref?: string;
  /** A commit-message filter; absent = every commit. */
  readonly query?: string;
}

/** One branch of the repository, for the history tab's picker (§6). */
export interface BranchEntry {
  /** `refname:short` — `main`, `feature/x`, `origin/main`. */
  readonly name: string;
  readonly kind: "local" | "remote";
  /** The tracked upstream, short, or null (remotes have none). */
  readonly upstream: string | null;
  /** HEAD's own branch. */
  readonly current: boolean;
}

export interface BranchList {
  /** HEAD's branch, or null when detached / unborn. */
  readonly current: string | null;
  /** Newest commit first, locals before remotes. */
  readonly branches: readonly BranchEntry[];
}

export const LOG_PAGE_SIZE = 50;
export const MAX_LOG_LIMIT = 200;
export const MAX_LOG_QUERY_CHARS = 200;
export const MAX_BRANCHES = 200;
/** Unpushed marks are bounded: a branch thousands of commits ahead of a
 *  stale upstream is not what the mark is for. */
const MAX_UNPUSHED = 5_000;
const FIELD = "\x1f";

/**
 * A ref name the reader is willing to hand git: git's own ref-format
 * rules, minus everything that could read as an option or a revision
 * expression — no leading `-`, no whitespace or control characters, none
 * of `~ ^ : ? * [ \`, no `..`, no `@{`, no leading `/`, no trailing `/`
 * or `.lock`. The reader composes `<ref>@{upstream}` itself. Exported for
 * the IPC door, which checks the same shape before the session is asked.
 */
export function isSafeRefName(ref: string): boolean {
  if (ref.length === 0 || ref.length > 255) return false;
  if (ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/"))
    return false;
  if (ref.endsWith(".lock") || ref.includes("..") || ref.includes("@{"))
    return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what a ref must not carry
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(ref)) return false;
  return true;
}

/** Null when git cannot read the history; `GIT_READ_TIMEOUT` when the
 *  clock ended the read (ADR 0058 §7.7) — a `--grep` over a huge history
 *  is "timed out; try again", not "not found". */
export async function describeLog(
  workspaceRoot: string,
  opts: LogQuery,
  signal?: AbortSignal,
  readOpts?: GitReadOptions,
): Promise<LogPage | null | GitReadTimeout> {
  try {
    return await describe(workspaceRoot, opts, signal, readOpts);
  } catch {
    return null;
  }
}

/** The set of commits not on `ref`'s upstream, or empty when there is
 *  none; the upstream's name; and whether it is GONE — configured but its
 *  ref deleted (a merged PR's branch pruned), git's `[gone]`, in which case
 *  nothing on the branch is published and the set cannot be measured (ADR
 *  0058 §7). Exported for the probe, which marks the card's own ten with it. */
export async function unpushedShas(
  workspaceRoot: string,
  signal: AbortSignal,
  timeoutMs: number,
  ref = "HEAD",
): Promise<{
  readonly shas: ReadonlySet<string>;
  readonly upstream: string | null;
  readonly gone: boolean;
}> {
  // `@{upstream}` on a branch without one — or with a gone one — exits 128:
  // an answer (nothing to measure against), not a failure.
  const [list, full, refs] = await Promise.all([
    spawnGit(
      workspaceRoot,
      hardenedGitArgs([
        "rev-list",
        "--max-count",
        String(MAX_UNPUSHED),
        "--end-of-options",
        `${ref}@{upstream}..${ref}`,
      ]),
      signal,
      { timeoutMs, allowExitCodes: [128] },
    ),
    // The ref's full name (`refs/heads/main`; `HEAD` when detached; 128 on
    // an unborn HEAD). No `--end-of-options` here: rev-parse ECHOES it as a
    // revision instead of honouring it (git 2.51, seen in the tests). The
    // ref's shape is the guard for this spawn — `isSafeRefName` refuses a
    // leading `-`.
    spawnGit(
      workspaceRoot,
      hardenedGitArgs(["rev-parse", "--symbolic-full-name", ref]),
      signal,
      { timeoutMs, allowExitCodes: [128] },
    ),
    // Every local branch's upstream and tracking state in one read; the
    // tracking column is where git says `[gone]`.
    spawnGit(
      workspaceRoot,
      hardenedGitArgs([
        "for-each-ref",
        `--format=%(refname)${FIELD}%(upstream:short)${FIELD}%(upstream:track)`,
        "refs/heads",
      ]),
      signal,
      { timeoutMs },
    ),
  ]);
  let upstream: string | null = null;
  let gone = false;
  if (full.ok && full.exitCode === 0 && refs.ok) {
    const name = full.stdout.trim();
    for (const line of refs.stdout.split("\n")) {
      const [refname = "", up = "", track = ""] = line.split(FIELD);
      if (refname !== name) continue;
      if (up.length > 0) upstream = up;
      gone = track.trim() === "[gone]";
      break;
    }
  }
  const shas =
    list.ok && list.exitCode === 0
      ? new Set(
          list.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0),
        )
      : new Set<string>();
  return { shas, upstream, gone };
}

async function describe(
  workspaceRoot: string,
  opts: LogQuery,
  signal?: AbortSignal,
  readOpts?: GitReadOptions,
): Promise<LogPage | null | GitReadTimeout> {
  const skip = Number.isInteger(opts.skip) && opts.skip >= 0 ? opts.skip : -1;
  const limit =
    Number.isInteger(opts.limit) && opts.limit > 0
      ? Math.min(opts.limit, MAX_LOG_LIMIT)
      : -1;
  if (skip < 0 || limit < 0) return null;
  const ref = opts.ref ?? "HEAD";
  if (ref !== "HEAD" && !isSafeRefName(ref)) return null;
  const query = opts.query?.trim() ?? "";
  if (query.length > MAX_LOG_QUERY_CHARS) return null;
  const sig = signal ?? new AbortController().signal;
  const timeoutMs = readOpts?.timeoutMs ?? 5_000;

  // `log` exits 128 both outside a repository and on an unborn HEAD; the
  // `--verify --quiet` probe tells them apart (128 = no repository, which
  // stays a failure; 1 = no commits / no such ref, which is an empty
  // history).
  const [head, log, marks] = await Promise.all([
    spawnGit(
      workspaceRoot,
      hardenedGitArgs(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]),
      sig,
      { timeoutMs, allowExitCodes: [1] },
    ),
    spawnGit(
      workspaceRoot,
      hardenedGitArgs([
        "log",
        "-z",
        `--format=%H${FIELD}%h${FIELD}%an${FIELD}%aI${FIELD}%s`,
        "--skip",
        String(skip),
        "-n",
        String(limit + 1),
        // The query rides INSIDE one argv token, so a value that starts
        // with `-` can never become an option of its own.
        ...(query.length > 0
          ? ["--fixed-strings", "--regexp-ignore-case", `--grep=${query}`]
          : []),
        "--end-of-options",
        ref,
        "--",
      ]),
      sig,
      { timeoutMs, allowExitCodes: [128] },
    ),
    unpushedShas(workspaceRoot, sig, timeoutMs, ref),
  ]);
  if (!head.ok || !log.ok) {
    return anyTimedOut([head, log]) ? GIT_READ_TIMEOUT : null;
  }
  const records =
    head.exitCode === 0 && log.exitCode === 0
      ? log.stdout.split("\0").filter((r) => r.length > 0)
      : [];
  const entries: LogEntry[] = [];
  for (const rec of records.slice(0, limit)) {
    const [sha = "", shortSha = "", author = "", authoredAt = "", ...rest] =
      rec.split(FIELD);
    if (sha.length === 0) continue;
    entries.push({
      sha,
      shortSha,
      author,
      authoredAt,
      subject: rest.join(FIELD),
      unpushed: marks.gone || marks.shas.has(sha),
    });
  }
  return {
    entries,
    skip,
    hasMore: records.length > limit,
    upstream: marks.upstream,
    upstreamGone: marks.gone,
  };
}

/**
 * The repository's branches for the history tab's picker (§6): locals
 * then remotes, newest commit first, HEAD's own marked. Read-only — the
 * picker chooses whose history to READ; nothing here checks out. Null,
 * never a throw, outside a repository.
 */
export async function describeBranches(
  workspaceRoot: string,
  signal?: AbortSignal,
  readOpts?: GitReadOptions,
): Promise<BranchList | null | GitReadTimeout> {
  try {
    return await branches(workspaceRoot, signal, readOpts);
  } catch {
    return null;
  }
}

async function branches(
  workspaceRoot: string,
  signal?: AbortSignal,
  readOpts?: GitReadOptions,
): Promise<BranchList | null | GitReadTimeout> {
  const sig = signal ?? new AbortController().signal;
  const timeoutMs = readOpts?.timeoutMs ?? 5_000;
  const refs = await spawnGit(
    workspaceRoot,
    hardenedGitArgs([
      "for-each-ref",
      `--format=%(refname)${FIELD}%(refname:short)${FIELD}%(upstream:short)${FIELD}%(HEAD)`,
      "--sort=-committerdate",
      "--count",
      String(MAX_BRANCHES),
      "refs/heads",
      "refs/remotes",
    ]),
    sig,
    { timeoutMs },
  );
  if (!refs.ok) return anyTimedOut([refs]) ? GIT_READ_TIMEOUT : null;
  const locals: BranchEntry[] = [];
  const remotes: BranchEntry[] = [];
  for (const line of refs.stdout.split("\n")) {
    if (line.length === 0) continue;
    const [full = "", name = "", upstream = "", headMark = ""] =
      line.split(FIELD);
    if (name.length === 0) continue;
    if (full.startsWith("refs/heads/")) {
      locals.push({
        name,
        kind: "local",
        upstream: upstream.length > 0 ? upstream : null,
        current: headMark.trim() === "*",
      });
    } else if (full.startsWith("refs/remotes/") && !full.endsWith("/HEAD")) {
      // `origin/HEAD` is the remote's pointer, not a branch to browse.
      remotes.push({ name, kind: "remote", upstream: null, current: false });
    }
  }
  return {
    current: locals.find((b) => b.current)?.name ?? null,
    branches: [...locals, ...remotes],
  };
}
