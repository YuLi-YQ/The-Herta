const SERIES_SUFFIX = /（其[一二三四五六七八九十百零〇\d]+）\s*$/;

/** The same character set promoteCandidate sanitizes out of FILENAMES
 *  (`/\:*?"<>|` → `_`). Folded into normalization (audit 2026-07-10,
 *  finding 24) because `existingTitles()` derives titles from filenames
 *  while candidates arrive raw: a 废案 titled `Unix/Windows 的抉择` was
 *  stored as `Unix_Windows…`, so a later identical candidate compared
 *  unequal, passed the title pre-screen, and only the (fallible) LLM
 *  similarity gate stood between it and a duplicate promotion. */
const FILENAME_SANITIZED = /[/\\:*?"<>|]/g;

export function normalizeTitle(title: string): string {
  // Case fold is COMPARISON-ONLY (audit 2026-07-16): stored titles and
  // filenames keep their case; this only stops an EN title differing solely
  // by case ("The Same Evening" vs "the same evening") from passing the
  // deterministic pre-screen. A no-op for CJK.
  return title
    .replace(SERIES_SUFFIX, "")
    .replace(FILENAME_SANITIZED, "_")
    .trim()
    .toLowerCase();
}

/** A series instalment (（其N）) is exempt: same base title is allowed. */
function isSeriesOf(a: string, b: string): boolean {
  return (
    SERIES_SUFFIX.test(a) &&
    SERIES_SUFFIX.test(b) &&
    normalizeTitle(a) === normalizeTitle(b)
  );
}

/** True when `title` is sufficiently distinct from every existing title.
 *  Cheap, embedding-free: exact-normalized-match rejects; series instalments
 *  are exempt. This guards FILENAME/TITLE collisions only — a different job
 *  from occasion identity, which the DeepSeek reactivation gate in
 *  run-dream-pass judges separately on the episode (ADR 0021). */
export function titleNoveltyOk(title: string, existing: string[]): boolean {
  const norm = normalizeTitle(title);
  for (const e of existing) {
    if (isSeriesOf(title, e)) continue;
    if (normalizeTitle(e) === norm) return false;
  }
  return true;
}
