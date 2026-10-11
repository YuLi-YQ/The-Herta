export interface GitStatusFile {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  origPath?: string;
}

export interface GitStatusData {
  branch: string | null;
  /** The tracked upstream ref (e.g. "origin/main"). Absent when the branch
   *  has no upstream. Only the `-z` parser fills it (ADR 0049 §1). */
  upstream?: string;
  /** The upstream is configured but its ref no longer exists — git's
   *  `[gone]` (a merged PR's branch deleted on the remote). The counts are
   *  then 0 only because git cannot measure against it: every commit on
   *  the branch is unpublished (ADR 0058 §7). */
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  files: readonly GitStatusFile[];
  clean: boolean;
}

/**
 * Parse `git status --porcelain=v1 -z --branch --untracked-files=all`.
 *
 * `-z` fixes two things the newline form got wrong. Paths are emitted RAW,
 * where the default `core.quotePath` C-quotes any non-ASCII name — so
 * `中文note.md` arrived as thirty characters of octal that no tool could open,
 * for the audience this product is primarily built for. And a path containing
 * a newline (legal on POSIX) could not be represented at all.
 *
 * A rename emits `XY <new>\0<orig>\0` — **NEW first, then OLD, which is the
 * OPPOSITE of `diff --numstat -z`.** The two parsers deliberately do not share
 * a helper: the inversion is invisible until a real rename appears.
 *
 * `## No commits yet on main` is also handled here. It is a human SENTENCE,
 * and slicing it the way a normal header is sliced yielded the literal string
 * "No commits yet on main" as the branch name.
 */
export function parseStatusPorcelainZ(text: string): GitStatusData {
  let branch: string | null = null;
  let upstream: string | undefined;
  let upstreamGone = false;
  let ahead = 0;
  let behind = 0;
  const files: GitStatusFile[] = [];

  const records = text.split("\0");
  let i = 0;
  while (i < records.length) {
    const rec = records[i];
    if (rec === undefined || rec.length === 0) {
      i += 1;
      continue;
    }
    if (rec.startsWith("## ")) {
      let branchPart = rec.slice(3);
      if (branchPart.startsWith("HEAD (no branch)")) {
        branch = null;
        i += 1;
        continue;
      }
      // An unborn HEAD is a real branch that simply has no commit yet.
      const unborn = "No commits yet on ";
      if (branchPart.startsWith(unborn))
        branchPart = branchPart.slice(unborn.length);
      const trackingIdx = branchPart.indexOf("...");
      const nameEnd = trackingIdx >= 0 ? trackingIdx : branchPart.length;
      branch = branchPart.slice(0, nameEnd).trim();
      if (trackingIdx >= 0) {
        // `main...origin/main [ahead 1]` → the upstream name runs to the
        // ` [`-delimited tracking info, or to the end when in sync.
        const afterDots = branchPart.slice(trackingIdx + 3);
        const bracket = afterDots.indexOf(" [");
        const name = (
          bracket >= 0 ? afterDots.slice(0, bracket) : afterDots
        ).trim();
        if (name.length > 0) upstream = name;
      }
      const trackInfo = branchPart.match(/\[([^\]]+)\]/)?.[1];
      if (trackInfo) {
        if (trackInfo.trim() === "gone") upstreamGone = true;
        const aheadMatch = trackInfo.match(/ahead (\d+)/);
        const behindMatch = trackInfo.match(/behind (\d+)/);
        if (aheadMatch?.[1]) ahead = Number.parseInt(aheadMatch[1], 10);
        if (behindMatch?.[1]) behind = Number.parseInt(behindMatch[1], 10);
      }
      i += 1;
      continue;
    }
    if (rec.length < 3) {
      i += 1;
      continue;
    }
    const indexStatus = rec[0] ?? " ";
    const worktreeStatus = rec[1] ?? " ";
    const path = rec.slice(3);
    if (indexStatus === "R" || indexStatus === "C") {
      const origPath = records[i + 1];
      files.push({
        path,
        indexStatus,
        worktreeStatus,
        ...(origPath !== undefined && origPath.length > 0 ? { origPath } : {}),
      });
      i += 2;
      continue;
    }
    files.push({ path, indexStatus, worktreeStatus });
    i += 1;
  }

  return {
    branch,
    ...(upstream !== undefined ? { upstream } : {}),
    ahead,
    behind,
    files,
    upstreamGone,
    clean: files.length === 0,
  };
}

/** @deprecated the newline form C-quotes non-ASCII paths; see
 *  {@link parseStatusPorcelainZ}. Kept so the old fixtures still compile. */
export function parseStatusPorcelain(text: string): GitStatusData {
  const lines = text.split("\n");
  let branch: string | null = null;
  let upstreamGone = false;
  let ahead = 0;
  let behind = 0;
  const files: GitStatusFile[] = [];

  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith("## ")) {
      const branchPart = line.slice(3);
      if (branchPart.startsWith("HEAD (no branch)")) {
        branch = null;
      } else {
        const trackingIdx = branchPart.indexOf("...");
        const nameEnd = trackingIdx >= 0 ? trackingIdx : branchPart.length;
        branch = branchPart.slice(0, nameEnd);
        const trackInfo = branchPart.match(/\[([^\]]+)\]/)?.[1];
        if (trackInfo) {
          if (trackInfo.trim() === "gone") upstreamGone = true;
          const aheadMatch = trackInfo.match(/ahead (\d+)/);
          const behindMatch = trackInfo.match(/behind (\d+)/);
          if (aheadMatch?.[1]) ahead = Number.parseInt(aheadMatch[1], 10);
          if (behindMatch?.[1]) behind = Number.parseInt(behindMatch[1], 10);
        }
      }
      continue;
    }
    if (line.length < 3) continue;
    const indexStatus = line[0] ?? " ";
    const worktreeStatus = line[1] ?? " ";
    const rest = line.slice(3);
    if (indexStatus === "R" || indexStatus === "C") {
      const arrow = rest.indexOf(" -> ");
      if (arrow >= 0) {
        const origPath = rest.slice(0, arrow);
        const path = rest.slice(arrow + 4);
        files.push({ path, indexStatus, worktreeStatus, origPath });
        continue;
      }
    }
    files.push({ path: rest, indexStatus, worktreeStatus });
  }

  return {
    branch,
    ahead,
    behind,
    files,
    upstreamGone,
    clean: files.length === 0,
  };
}
