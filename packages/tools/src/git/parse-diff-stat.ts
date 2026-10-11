export interface GitDiffFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface ParseDiffStatResult {
  files: readonly GitDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

/**
 * Parse `git diff --numstat -z`.
 *
 * The previous parser read `--stat`, which is a DISPLAY format, and the two
 * things it took from it were both fabricated (measured 2026-08-25):
 *   - the `+`/`-` run is a HISTOGRAM git scales to terminal width, so counting
 *     its characters reported a 400-insertion change as `+66`;
 *   - long paths are elided to `.../Conversation/Foo.tsx`, which `read_file`,
 *     `show_excerpt` and `report_finding` all reject — so the answer could not
 *     become a next step, and under ADR 0039 both values were cited into
 *     durable findings that Herta narrates as ground truth.
 *
 * `--numstat -z` gives real counts and full, unescaped paths. Records are
 * NUL-terminated; a RENAME emits three fields — `adds \t dels \t NUL old NUL
 * new NUL`. **The order is OLD then NEW here and NEW then OLD in
 * `status -z`** — the two must not share a helper, because the inversion is
 * invisible until a real rename shows up in a user's session.
 *
 * A binary file reports `-` for both counts; that stays 0, as before.
 */
export function parseDiffStatZ(text: string): ParseDiffStatResult {
  const files: GitDiffFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;
  const fields = text.split("\0");
  let i = 0;
  while (i < fields.length) {
    const head = fields[i];
    if (head === undefined || head.length === 0) {
      i += 1;
      continue;
    }
    // `<adds> \t <dels> \t <path>` — or `<adds> \t <dels> \t` for a rename,
    // whose two paths are the next two NUL records.
    const firstTab = head.indexOf("\t");
    const secondTab = head.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) {
      i += 1;
      continue;
    }
    const addsRaw = head.slice(0, firstTab);
    const delsRaw = head.slice(firstTab + 1, secondTab);
    const inline = head.slice(secondTab + 1);
    const additions = addsRaw === "-" ? 0 : Number.parseInt(addsRaw, 10) || 0;
    const deletions = delsRaw === "-" ? 0 : Number.parseInt(delsRaw, 10) || 0;
    let path: string;
    if (inline.length > 0) {
      path = inline;
      i += 1;
    } else {
      // Rename/copy: OLD is next, NEW is the one after. Report the NEW path —
      // it is the one that exists on disk and can be opened.
      const newPath = fields[i + 2];
      path =
        newPath !== undefined && newPath.length > 0
          ? newPath
          : (fields[i + 1] ?? "");
      i += 3;
    }
    if (path.length === 0) continue;
    files.push({ path, additions, deletions });
    totalAdditions += additions;
    totalDeletions += deletions;
  }
  return { files, totalAdditions, totalDeletions };
}

/** @deprecated `--stat` is a display format; see {@link parseDiffStatZ}. Kept
 *  only so the pinned fixtures for the old shape still compile. */
export function parseDiffStat(text: string): ParseDiffStatResult {
  if (text.length === 0) {
    return { files: [], totalAdditions: 0, totalDeletions: 0 };
  }
  const lines = text.split("\n");
  const files: GitDiffFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const raw of lines) {
    if (raw.length === 0) continue;
    if (/files? changed/.test(raw) && raw.includes(",")) continue;
    const pipeIdx = raw.indexOf("|");
    if (pipeIdx < 0) continue;
    const path = raw.slice(0, pipeIdx).trim();
    const right = raw.slice(pipeIdx + 1).trim();
    if (path.length === 0) continue;

    let additions = 0;
    let deletions = 0;
    if (right.startsWith("Bin")) {
      // Binary file — keep counts at zero
    } else {
      for (const ch of right) {
        if (ch === "+") additions += 1;
        else if (ch === "-") deletions += 1;
      }
    }
    files.push({ path, additions, deletions });
    totalAdditions += additions;
    totalDeletions += deletions;
  }

  return { files, totalAdditions, totalDeletions };
}
