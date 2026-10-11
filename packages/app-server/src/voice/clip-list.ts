import { readdir } from "node:fs/promises";

/**
 * List the clip ids (filename stems) of the `*.opus` files directly under
 * `dir` — a FLAT voice category like `veto/` or `easter_egg/`, where each file
 * is one full-line clip (contrast with `particle/`, which nests variants under
 * token subdirs). Opus-only since the 2026-07-16 wav→opus cutover: the dev
 * tree keeps `.wav` masters beside the `.opus` files, and listing both would
 * duplicate every stem. Sorted for determinism. Best-effort: a
 * missing/unreadable dir → `[]` (the category simply never fires), never
 * throws.
 */
export async function loadClipStems(dir: string): Promise<readonly string[]> {
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => /\.opus$/i.test(f))
      .map((f) => f.replace(/\.opus$/i, ""))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Pick a random clip id from `stems`, or null when empty. `random` is injected
 * for deterministic tests (default callers pass `Math.random`).
 */
export function pickClipStem(
  stems: readonly string[],
  random: () => number,
): string | null {
  if (stems.length === 0) return null;
  const idx = Math.min(stems.length - 1, Math.floor(random() * stems.length));
  return stems[idx] ?? null;
}

/**
 * Like {@link pickClipStem}, but never returns `avoid` (the just-played clip)
 * when there is more than one clip to choose from — so two consecutive plays
 * don't repeat the same clip. Falls back to a normal pick when there is a single
 * clip (a repeat is unavoidable), when `avoid` is null, or when `avoid` is not
 * among `stems`.
 */
export function pickClipStemAvoiding(
  stems: readonly string[],
  random: () => number,
  avoid: string | null,
): string | null {
  if (avoid === null || stems.length <= 1) return pickClipStem(stems, random);
  const pool = stems.filter((s) => s !== avoid);
  // `avoid` wasn't in `stems` → pool === stems; pick from the full set.
  return pickClipStem(pool.length > 0 ? pool : stems, random);
}
