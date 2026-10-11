import type { CommitFileChange } from "@herta/app-server";
import type { Locale } from "../../../ipc/bridge-types.js";

/**
 * One file's hunks, cut from a `git show` patch (ADR 0059). Section k is
 * file k of the commit's `--name-status` list: both come out of the same
 * diff queue in the same order, so the two align without parsing the
 * `diff --git a/x b/x` header — whose spelling is ambiguous for a path
 * with a space once quoting is off. The header lines before the first
 * hunk are dropped (the section's own header row names the file); a
 * `Binary files … differ` line is kept as a `\ ` aside so DiffBody
 * renders it as a statement about the diff, not as content. A truncated
 * patch simply yields fewer sections than files.
 */
export function splitPatchByFile(patch: string): readonly string[] {
  if (patch.length === 0) return [];
  const sections: string[][] = [];
  let current: string[] | null = null;
  let inHunks = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = [];
      sections.push(current);
      inHunks = false;
      continue;
    }
    if (current === null) continue;
    if (!inHunks) {
      if (line.startsWith("@@")) {
        inHunks = true;
      } else {
        if (line.startsWith("Binary files ")) current.push(`\\ ${line}`);
        continue;
      }
    }
    current.push(line);
  }
  return sections.map((lines) => {
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  });
}

/** Lines added / deleted across the files that have a count (binaries
 *  carry none and are not a zero). */
export function commitTotals(files: readonly CommitFileChange[]): {
  readonly added: number;
  readonly deleted: number;
} {
  let added = 0;
  let deleted = 0;
  for (const f of files) {
    if (f.added !== null) added += f.added;
    if (f.deleted !== null) deleted += f.deleted;
  }
  return { added, deleted };
}

/** The author date in the UI locale's own order (`Sep 7, 2026, 15:02` /
 *  `2026年9月7日 15:02`); "" for a date git could not spell. `timeZone`
 *  defaults to the user's; tests pass "UTC". */
export function formatCommitDate(
  iso: string,
  locale: Locale,
  timeZone?: string,
): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(timeZone !== undefined ? { timeZone } : {}),
  }).format(ms);
}
