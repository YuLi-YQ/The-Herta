/**
 * Deterministic gate: a 废案's （开拓者 说） lines must be TRACEABLE to the
 * source episode's real user messages (persona E2E 2026-08-11, ADR 0036).
 *
 * The LLM faithfulness critique scores "does the page dramatize the source
 * episode's core event" — and passed a counterfeit that dramatized the theme
 * with FOUR invented user turns, complete with quoted dialogue the 开拓者
 * never typed. Once promoted, those lines sit in the static prefix as
 * first-person memory: the actor then "remembers" conversations that never
 * happened, and no downstream check can catch it, because the corpus itself
 * vouches for the fiction. Herta's own words may be dreamed loosely — they
 * are hers to reinterpret — but the 开拓者's words are EVIDENCE, the one
 * part of an episode she cannot have experienced differently.
 *
 * The rule is structural, not semantic: every （开拓者 说） block in the
 * draft must be a contiguous quotation (truncation allowed) of one real user
 * message — or, line by line, quotations of real messages (dreams may elide
 * the middle of a long message). Matching is whitespace- and zero-width-
 * insensitive: `escapeUserText` plants ZWSPs in the record's user text (the
 * neutralized `@板砖` and friends) which the dream may or may not reproduce,
 * and `validateFeian` strips zero-widths from drafts anyway.
 *
 * Deliberately NOT a similarity threshold: paraphrase is exactly the failure
 * mode (a paraphrased user line reads as memory of a different conversation),
 * so the gate demands quotation. The refine loop gets the failures as
 * must-fix errors first — a draft with invented dialogue is given the chance
 * to re-quote before it is archived.
 */

const TRAILBLAZER_BLOCK_RE = /（开拓者 说）\n?([\s\S]*?)（\/开拓者 说）/g;

/** Strip whitespace and zero-width/invisible codepoints for matching.
 *  Escapes, not literals, so the source stays printable (same discipline as
 *  feian-format.ts's BAD_RANGES): ZWSP/ZWNJ/ZWJ, word joiner, BOM. */
function normalizeForMatch(s: string): string {
  return s.replace(/(?:\s|\u200B|\u200C|\u200D|\u2060|\uFEFF)+/gu, "");
}

/** All （开拓者 说） block bodies in a draft, raw (untrimmed matching is done
 *  by the caller via normalization). */
export function extractTrailblazerLines(feian: string): string[] {
  const out: string[] = [];
  for (const m of feian.matchAll(TRAILBLAZER_BLOCK_RE)) {
    const body = (m[1] ?? "").trim();
    if (body.length > 0) out.push(body);
  }
  return out;
}

/** Below this many normalized chars a fragment is too weak to call invented —
 *  a two-character interjection (嗯。/……) matches half the record by luck and
 *  fabricates nothing worth blocking. */
const MIN_FRAGMENT_CHARS = 6;

export interface UserLineGateResult {
  readonly ok: boolean;
  /** One refine-loop error string per untraceable block (empty when ok). */
  readonly errors: readonly string[];
}

/**
 * Validate a draft 废案's 开拓者 dialogue against the episode's real user
 * messages (plus any extra trusted sources — the reconsolidation junction
 * passes the OLD record's already-validated lines).
 */
export function validateUserLines(
  feian: string,
  sourceUserTexts: readonly string[],
): UserLineGateResult {
  const sources = sourceUserTexts
    .map(normalizeForMatch)
    .filter((s) => s.length > 0);
  const errors: string[] = [];

  for (const block of extractTrailblazerLines(feian)) {
    const whole = normalizeForMatch(block);
    if (whole.length < MIN_FRAGMENT_CHARS) continue;
    if (sources.some((s) => s.includes(whole))) continue;

    // Line-by-line fallback: a dream may elide the middle of one long
    // message. Every substantial line must still be a quotation.
    const lines = block
      .split(/\r?\n/)
      .map(normalizeForMatch)
      .filter((l) => l.length >= MIN_FRAGMENT_CHARS);
    const allLinesTraceable =
      lines.length > 0 &&
      lines.every((l) => sources.some((s) => s.includes(l)));
    if (allLinesTraceable) continue;

    const snippet = block.replace(/\s+/g, " ").slice(0, 40);
    errors.push(
      `（开拓者 说）块里出现了原始记录中不存在的开拓者台词：「${snippet}${block.length > 40 ? "…" : ""}」` +
        "——开拓者的台词只能从记录原文摘取（可截取，不可改写、不可虚构）；" +
        "拿不准原文时，宁可用叙述转述（不带对话框），也不要给他编台词。",
    );
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}
