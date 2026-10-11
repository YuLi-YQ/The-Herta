import {
  anyTimedOut,
  GIT_READ_TIMEOUT,
  type GitReadTimeout,
  hardenedGitArgs,
  spawnGit,
} from "./spawn-git.js";

/**
 * One commit, described for the viewer's commit tab (ADR 0059): the
 * message, who and when, the files it touched with their line counts, and
 * the patch. User-facing display chrome — nothing here reaches a model or
 * the record.
 *
 * Same null-never-throw contract as the repo probe: an unknown or
 * ambiguous id, no repository, a timeout, an abort all answer null and the
 * panel shows one honest notice.
 */

export type CommitFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "unmerged"
  | "other";

export interface CommitFileChange {
  /** Root-relative, git's spelling (the NEW path for a rename). */
  readonly path: string;
  /** The OLD path of a rename / copy. */
  readonly oldPath?: string;
  readonly status: CommitFileStatus;
  /** Lines added / deleted; null for a binary file. */
  readonly added: number | null;
  readonly deleted: number | null;
}

export interface CommitDescription {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  /** The message past the subject, trailing whitespace shed; "" when none. */
  readonly body: string;
  readonly author: string;
  /** ISO 8601 author date. */
  readonly authoredAt: string;
  readonly parents: readonly string[];
  /** Bounded to MAX_COMMIT_FILES; `filesTotal` keeps the honest count. */
  readonly files: readonly CommitFileChange[];
  readonly filesTotal: number;
  /** Unified diff against the first parent (the whole tree for a root
   *  commit), no colour, renames detected; a PREFIX when `patchTruncated`. */
  readonly patch: string;
  readonly patchTruncated: boolean;
}

/** A commit id as the caller may spell it: abbreviated is fine; anything
 *  that is not hex never reaches a git argv (the `--ext-diff` class). */
const COMMIT_ID = /^[0-9a-f]{4,64}$/;

/** The patch cap. A side panel shows a review, not an archive; the notice
 *  says the patch continues. */
export const MAX_COMMIT_PATCH_BYTES = 1024 * 1024;
export const MAX_COMMIT_FILES = 500;

/** The reader's one knob, for tests: the per-spawn budget. */
export interface GitReadOptions {
  readonly timeoutMs?: number;
}

/** Null when git cannot show the commit; `GIT_READ_TIMEOUT` when the clock
 *  ended the read (ADR 0058 §7.7) — unknown, not absent. */
export async function describeCommit(
  workspaceRoot: string,
  ref: string,
  signal?: AbortSignal,
  readOpts?: GitReadOptions,
): Promise<CommitDescription | null | GitReadTimeout> {
  try {
    return await describe(workspaceRoot, ref, signal, readOpts);
  } catch {
    return null;
  }
}

/** Diff options shared by the three views of one commit: renames detected,
 *  a merge shown against its FIRST parent (what `git show` would otherwise
 *  print is the dense combined form nobody reviews by), and no external
 *  or textconv program — `-c diff.external=` already neutralises the
 *  config, the flags make the intent explicit. */
const DIFF_OPTS: readonly string[] = [
  "--format=",
  "-M",
  "--diff-merges=first-parent",
  "--no-ext-diff",
  "--no-textconv",
];

async function describe(
  workspaceRoot: string,
  ref: string,
  signal?: AbortSignal,
  readOpts?: GitReadOptions,
): Promise<CommitDescription | null | GitReadTimeout> {
  if (!COMMIT_ID.test(ref)) return null;
  const sig = signal ?? new AbortController().signal;
  const opts = { timeoutMs: readOpts?.timeoutMs ?? 5_000 } as const;

  const [meta, names, nums, patch] = await Promise.all([
    spawnGit(
      workspaceRoot,
      hardenedGitArgs([
        "show",
        "-s",
        "--format=%H%x00%h%x00%an%x00%aI%x00%P%x00%s%x00%b",
        ref,
        "--",
      ]),
      sig,
      opts,
    ),
    spawnGit(
      workspaceRoot,
      hardenedGitArgs(["show", ...DIFF_OPTS, "--name-status", "-z", ref, "--"]),
      sig,
      opts,
    ),
    spawnGit(
      workspaceRoot,
      hardenedGitArgs(["show", ...DIFF_OPTS, "--numstat", "-z", ref, "--"]),
      sig,
      opts,
    ),
    spawnGit(
      workspaceRoot,
      hardenedGitArgs([
        "show",
        ...DIFF_OPTS,
        "--patch",
        "--no-color",
        ref,
        "--",
      ]),
      sig,
      { ...opts, maxBufBytes: MAX_COMMIT_PATCH_BYTES },
    ),
  ]);
  if (!meta.ok || !names.ok || !nums.ok || !patch.ok) {
    return anyTimedOut([meta, names, nums, patch]) ? GIT_READ_TIMEOUT : null;
  }

  const fields = meta.stdout.split("\0");
  const sha = fields[0] ?? "";
  if (!COMMIT_ID.test(sha)) return null;
  const statuses = parseNameStatusZ(names.stdout);
  const counts = parseNumstatZ(nums.stdout);
  const files: CommitFileChange[] = [];
  for (const s of statuses) {
    if (files.length >= MAX_COMMIT_FILES) break;
    const c = counts.get(s.path);
    files.push({
      path: s.path,
      ...(s.oldPath !== undefined ? { oldPath: s.oldPath } : {}),
      status: s.status,
      added: c?.added ?? null,
      deleted: c?.deleted ?? null,
    });
  }

  return {
    sha,
    shortSha: fields[1] ?? sha.slice(0, 7),
    author: fields[2] ?? "",
    authoredAt: fields[3] ?? "",
    parents: (fields[4] ?? "").split(" ").filter((p) => p.length > 0),
    subject: fields[5] ?? "",
    body: (fields[6] ?? "").trimEnd(),
    files,
    filesTotal: statuses.length,
    patch: patch.stdout,
    patchTruncated: patch.truncated,
  };
}

const STATUS_BY_LETTER: Readonly<Record<string, CommitFileStatus>> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
  U: "unmerged",
};

/**
 * `--name-status -z`: `M\0path\0`, `A\0path\0`, …, and for a rename or copy
 * `R095\0old\0new\0` — OLD first, then NEW (the opposite of porcelain
 * status, which parse-status.ts warns about). Exported for tests.
 */
export function parseNameStatusZ(text: string): ReadonlyArray<{
  readonly path: string;
  readonly oldPath?: string;
  readonly status: CommitFileStatus;
}> {
  const out: Array<{
    path: string;
    oldPath?: string;
    status: CommitFileStatus;
  }> = [];
  const tokens = text.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i] ?? "";
    if (code.length === 0) {
      i += 1;
      continue;
    }
    const letter = code[0] ?? "";
    const status = STATUS_BY_LETTER[letter] ?? "other";
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[i + 1] ?? "";
      const path = tokens[i + 2] ?? "";
      if (path.length > 0) out.push({ path, oldPath, status });
      i += 3;
      continue;
    }
    const path = tokens[i + 1] ?? "";
    if (path.length > 0) out.push({ path, status });
    i += 2;
  }
  return out;
}

/**
 * `--numstat -z`: `add\tdel\tpath\0` per file, `-\t-` for a binary, and
 * for a rename `add\tdel\t\0old\0new\0` (an EMPTY third field, then the two
 * paths). Keyed by the NEW path. Exported for tests.
 */
export function parseNumstatZ(
  text: string,
): ReadonlyMap<string, { added: number | null; deleted: number | null }> {
  const out = new Map<
    string,
    { added: number | null; deleted: number | null }
  >();
  const tokens = text.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const rec = tokens[i] ?? "";
    if (rec.length === 0) {
      i += 1;
      continue;
    }
    const [a = "", d = "", inline = ""] = rec.split("\t");
    const added = a === "-" ? null : Number.parseInt(a, 10);
    const deleted = d === "-" ? null : Number.parseInt(d, 10);
    const counts = {
      added: added !== null && Number.isFinite(added) ? added : null,
      deleted: deleted !== null && Number.isFinite(deleted) ? deleted : null,
    };
    if (inline.length > 0) {
      out.set(inline, counts);
      i += 1;
      continue;
    }
    const path = tokens[i + 2] ?? "";
    if (path.length > 0) out.set(path, counts);
    i += 3;
  }
  return out;
}
