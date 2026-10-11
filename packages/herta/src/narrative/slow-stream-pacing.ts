/** Progress fraction where the verdict-pending slowdown ramp begins. */
export const RAMP_START = 0.55;
/** Progress fraction where the stream HOLDS until the verdict's terminal
 *  call (fastForward on OK / cancelAndBackspace on veto) arrives. */
export const HOLD_AT = 0.92;
/** Cadence multiplier reached at the hold boundary (linear ramp from 1x). */
export const RAMP_MAX_MULTIPLIER = 3.5;

/** ±ratio of base applied as uniform jitter to every char delay. */
export const JITTER_RATIO = 0.15;
/** Extra pause after clause/sentence punctuation, as a multiple of base. */
export const PUNCTUATION_PAUSE_RATIO = 2;
/** Extra pause after a newline, as a multiple of base. */
export const NEWLINE_PAUSE_RATIO = 4;
/** Characters that trigger the punctuation pause (matches the CLI's set). */
export const PAUSE_PUNCTUATION: ReadonlySet<string> = new Set([
  "。",
  "！",
  "？",
  "，",
  "；",
  "：",
  "、",
  "…",
  "—",
]);

/**
 * Humanized per-char delay shared by both slow-stream sinks (D9): a base
 * cadence with uniform jitter, plus a breath after punctuation/newlines.
 * `emittedChar` is the char JUST emitted (the pause trails it). `random`
 * is injected for deterministic tests (0.5 → zero jitter).
 */
export function humanizedCharDelay(args: {
  readonly emittedChar: string;
  readonly baseMs: number;
  readonly random: () => number;
}): number {
  const { emittedChar, baseMs, random } = args;
  const jitter = (random() * 2 - 1) * JITTER_RATIO * baseMs;
  let delay = baseMs + jitter;
  if (emittedChar === "\n") delay += NEWLINE_PAUSE_RATIO * baseMs;
  else if (PAUSE_PUNCTUATION.has(emittedChar)) {
    delay += PUNCTUATION_PAUSE_RATIO * baseMs;
  }
  return delay;
}

/**
 * Reveal granularity. `cjk` reveals ONE code point per unit at the humanized
 * per-char cadence — the status quo, and Herta's Chinese speaking rhythm.
 * `word` reveals a whole word (or a newline / space run) per unit at a
 * word-scaled cadence with ASCII sentence/clause breaths — used ONLY for EN
 * sessions, where a per-letter reveal reads as slow and unnatural. zh always
 * uses `cjk`; nothing here changes the zh path.
 */
export type PacingMode = "cjk" | "word";

/** EN word-reveal cadence (mode `word`). A unit delay = LEAD + PER_CHAR ×
 *  word-length, so a ~4.7-letter word lands in ~215 ms (~4.6 words/s — just
 *  above silent-reading speed, unhurried but not sluggish). */
export const EN_WORD_LEAD_MS = 140;
export const EN_WORD_PER_CHAR_MS = 16;
/** Base unit (ms) the ASCII breath multiples ride on — mirrors how the cjk
 *  path multiplies `baseMs`, so EN and zh share one ratio vocabulary. */
export const EN_WORD_BASE_MS = 200;
/** Effective per-code-point cadence for EN, used ONLY to size the CHAR-indexed
 *  startup buffer / live front-gate in the same units the char path uses
 *  (≈ per-word delay ÷ avg word+space length). Never a reveal delay itself. */
export const EN_EFFECTIVE_MS_PER_CHAR = 38;
/** ASCII sentence enders → a full breath (the EN analog of 。！？). */
export const EN_SENTENCE_PUNCT: ReadonlySet<string> = new Set([".", "!", "?"]);
/** ASCII clause punctuation → a short breath (the EN analog of ，；：). */
export const EN_CLAUSE_PUNCT: ReadonlySet<string> = new Set([",", ";", ":"]);

/** An inline space (NOT a newline — a newline is its own breath unit). */
function isInlineSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

/**
 * A CJK code point for PACING purposes (mixed-script fix, audit 2026-07-16):
 * ideographs, kana, Hangul, CJK punctuation, and fullwidth forms. In `word`
 * mode these are each their own reveal unit at the cjk cadence — Herta mixes
 * 中文 into EN sessions by design, and whitespace-only word-splitting turned a
 * spaceless zh clause into ONE giant "word" (multi-second silence, then the
 * whole clause slammed in with no 。！？ breaths). Deliberately NOT emoji or
 * ASCII — this is "text that types like Chinese", not "wide glyphs".
 */
export function isCjkPacingChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  return (
    (cp >= 0x3000 && cp <= 0x303f) || // CJK symbols & punctuation (。、「」)
    (cp >= 0x3040 && cp <= 0x30ff) || // hiragana + katakana
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms (！？，：；ａ-ｚ)
    (cp >= 0xffe0 && cp <= 0xffe6) || // fullwidth signs (￥￦…)
    (cp >= 0x20000 && cp <= 0x3ffff) // CJK ext B..H (astral ideographs)
  );
}

/**
 * Exclusive end index (code points) of the next reveal UNIT starting at
 * `cursor`. `cjk` → `cursor + 1` (status quo, one glyph). `word` → a lone
 * newline (its own breath unit), a run of inline spaces, a SINGLE CJK code
 * point (mixed-script text types like Chinese, glyph by glyph — see
 * isCjkPacingChar), or a word (run of non-whitespace, non-CJK) — the CJK
 * glyph and the word each swallow their trailing inline spaces, so "test "
 * emits as one delta and the next unit begins on the following word. Returns
 * `cursor` only at end-of-text; otherwise always advances by ≥1, so no
 * caller can spin.
 */
export function nextRevealEnd(
  chars: readonly string[],
  cursor: number,
  mode: PacingMode,
): number {
  const n = chars.length;
  if (cursor >= n) return cursor;
  if (mode === "cjk") return cursor + 1;
  const c = chars[cursor];
  if (c === "\n") return cursor + 1;
  let i = cursor;
  if (isInlineSpace(c)) {
    while (i < n && isInlineSpace(chars[i])) i += 1;
    return i;
  }
  if (isCjkPacingChar(c)) {
    // One glyph, plus trailing inline spaces (same swallow rule as a word).
    i = cursor + 1;
    while (i < n && isInlineSpace(chars[i])) i += 1;
    return i;
  }
  // A word: the non-whitespace run (a CJK glyph ends it — its own unit)…
  while (i < n) {
    const ch = chars[i];
    if (
      ch === undefined ||
      ch === "\n" ||
      isInlineSpace(ch) ||
      isCjkPacingChar(ch)
    ) {
      break;
    }
    i += 1;
  }
  // …plus its trailing inline spaces (a following newline stays its own unit).
  while (i < n && isInlineSpace(chars[i])) i += 1;
  return i;
}

/**
 * Delay (ms) after emitting the unit `chars[start..end)`. `cjk` → the existing
 * `humanizedCharDelay` on the single emitted char (byte-identical). `word` →
 * `EN_WORD_LEAD + EN_WORD_PER_CHAR × wordLen` (± JITTER), plus a breath: a
 * sentence breath (`EN_WORD_BASE × PUNCTUATION_PAUSE_RATIO`) when the unit's
 * last non-space char is `.`/`!`/`?` AND the unit ended on whitespace/EOT (so
 * "3.5" and inline dots don't stutter), a clause breath (`EN_WORD_BASE`) for
 * `,`/`;`/`:`, or a newline breath (`EN_WORD_BASE × NEWLINE_PAUSE_RATIO`) for a
 * newline unit. `wordLen` counts non-space code points only.
 */
export function revealUnitDelay(args: {
  readonly chars: readonly string[];
  readonly start: number;
  readonly end: number;
  readonly mode: PacingMode;
  readonly baseMs: number;
  readonly random: () => number;
}): number {
  const { chars, start, end, mode, baseMs, random } = args;
  if (mode === "cjk") {
    return humanizedCharDelay({
      emittedChar: chars[start] ?? "",
      baseMs,
      random,
    });
  }
  const unit = chars.slice(start, end);
  if (unit.length === 1 && unit[0] === "\n") {
    return EN_WORD_BASE_MS * NEWLINE_PAUSE_RATIO;
  }
  // A CJK glyph unit types at the cjk cadence — same humanized per-char delay
  // (and the same 。！？，… breath vocabulary) a zh session would use, so a
  // Chinese clause inside an EN session reads as Chinese, not as one giant
  // silent "word" that slams in whole.
  if (isCjkPacingChar(unit[0])) {
    return humanizedCharDelay({
      emittedChar: unit[0] ?? "",
      baseMs,
      random,
    });
  }
  let wordLen = 0;
  let lastNonSpace = "";
  for (const ch of unit) {
    if (ch !== "\n" && !isInlineSpace(ch)) {
      wordLen += 1;
      lastNonSpace = ch;
    }
  }
  const nominal = EN_WORD_LEAD_MS + EN_WORD_PER_CHAR_MS * wordLen;
  const jitter = (random() * 2 - 1) * JITTER_RATIO * nominal;
  let delay = nominal + jitter;
  // "Ends on a boundary": the unit swallowed a trailing space, or sits at EOT
  // (or right before a newline) — i.e. the punctuation genuinely ends a token.
  const endedOnBoundary =
    end >= chars.length || isInlineSpace(chars[end - 1]) || chars[end] === "\n";
  if (endedOnBoundary && EN_SENTENCE_PUNCT.has(lastNonSpace)) {
    delay += EN_WORD_BASE_MS * PUNCTUATION_PAUSE_RATIO;
  } else if (endedOnBoundary && EN_CLAUSE_PUNCT.has(lastNonSpace)) {
    delay += EN_WORD_BASE_MS;
  }
  return delay;
}

/**
 * Per-character base cadence (ms) that makes a humanized reveal of `text` span
 * ≈ `targetMs` — used to match a voiced stream's text speed to its audio clip
 * (wav-matched opening cadence, SPEC 2026-06-23). The estimate uses the SAME
 * weighting `humanizedCharDelay` applies — every char costs `base`, plus a
 * punctuation char costs `PUNCTUATION_PAUSE_RATIO·base` and a newline costs
 * `NEWLINE_PAUSE_RATIO·base` — so a reveal at the returned base lands close to
 * `targetMs`. Jitter is zero-mean, so it doesn't shift the span.
 *
 * `base = targetMs / weightedChars`. Returns `fallbackMs` when there's no usable
 * target (empty text, or a non-finite / non-positive `targetMs`). A hard `≥ 1`
 * floor guards degenerate ratios (e.g. a very short clip over very long text) —
 * this is a divide/zero safety net, NOT a feel clamp.
 */
export function spanMatchedBaseMs(args: {
  readonly text: string;
  readonly targetMs: number;
  readonly fallbackMs: number;
}): number {
  const { text, targetMs, fallbackMs } = args;
  if (!Number.isFinite(targetMs) || targetMs <= 0) return fallbackMs;
  let weighted = 0;
  for (const ch of text) {
    weighted += 1;
    if (ch === "\n") weighted += NEWLINE_PAUSE_RATIO;
    else if (PAUSE_PUNCTUATION.has(ch)) weighted += PUNCTUATION_PAUSE_RATIO;
  }
  if (weighted <= 0) return fallbackMs;
  return Math.max(1, targetMs / weighted);
}

/**
 * Wall-clock ceiling on a paced reveal (slice 3), measured from the first
 * emitted character — with the anchor RESTARTED when a pending verdict
 * resolves, so supervisor wait time never counts against it (the gate is
 * never bypassed either: the ceiling check sits behind the verdict hold).
 * Past the ceiling the sink flushes the remainder in one delta. At the
 * 80 ms/char base this only touches replies past ~200 chars plus pauses —
 * normal speech is byte-for-byte unchanged; a pathological multi-thousand-
 * char completion stops locking the composer for minutes.
 */
export const DEFAULT_MAX_REVEAL_MS = 18_000;

/** Env-tunable reveal ceiling (`HERTA_MAX_REVEAL_MS`), same override style as
 *  the diff-collapse knob. Non-numeric / non-positive values → default. */
export function resolveMaxRevealMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.HERTA_MAX_REVEAL_MS;
  if (raw === undefined) return DEFAULT_MAX_REVEAL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_REVEAL_MS;
}

/** Target wall-clock span (ms) a supervised paced reveal should occupy, so the
 *  verdict tends to land as the reveal finishes. Short lines wait UP FRONT
 *  (under the in-flight hint) for the difference instead of parking the last
 *  character behind the supervisor wait. Tuned to a typical short review. */
export const TARGET_VISIBLE_MS = 2800;
/** Ceiling on the startup buffer so even a one-word line never holds too long
 *  before any text appears. */
export const MAX_STARTUP_MS = 2000;

/**
 * Front-loaded startup buffer for a SUPERVISED paced reveal (SPEC stream-pacing
 * 2026-06-20). Returns how long to wait BEFORE emitting the first character so a
 * short line's reveal spans ~TARGET_VISIBLE_MS — shifting the supervisor wait to
 * the front (covered by the `消息正在穿越银河` in-flight hint) rather than the
 * back-portion hold, which collapses onto the final char for short speech. Long
 * lines whose un-ramped replay already meets the target get 0 (unchanged).
 *
 * `baseMs` is the caller sink's own per-char base cadence. The estimate
 * (total × baseMs) is the un-ramped, un-punctuation-paused lower bound on replay
 * time — deliberately conservative, so we only front-load when the reveal is
 * genuinely short. Returns 0 for empty text. Callers apply this ONLY when a
 * verdict is pending; unsupervised streams never ramp/hold, so they need no
 * front buffer.
 */
export function startupDelayMs(args: {
  readonly total: number;
  readonly baseMs: number;
}): number {
  const { total, baseMs } = args;
  if (total <= 0) return 0;
  const estimatedReplayMs = total * baseMs;
  return Math.min(
    MAX_STARTUP_MS,
    Math.max(0, TARGET_VISIBLE_MS - estimatedReplayMs),
  );
}

/** A ``` fenced region over a code-point `chars` array (slice 5): `start`
 *  is the opening fence line's first char, `end` is one past the closing
 *  fence line's newline (or the text end for an unclosed fence). `closed`
 *  distinguishes a real closing fence from the text simply ending — the LIVE
 *  sink streams over a growing buffer, where an open trailing fence means
 *  "the close hasn't arrived yet", not "unclosed" (non-live callers, whose
 *  text is complete, can ignore it). */
export interface FenceRegion {
  readonly start: number;
  readonly end: number;
  readonly closed: boolean;
}

const FENCE_OPEN_LINE = /^\s*```[^`\n]*\s*$/;
const FENCE_CLOSE_LINE = /^\s*```\s*$/;

/**
 * Locate ``` fenced regions in a reveal buffer (slice 5 Q1 pacing): a code
 * block typed out at 80 ms/char reads as agony — the sinks emit a fence
 * region ATOMICALLY (one delta), clamped to the verdict-hold index so the
 * supervisor gate is never bypassed. Indices are code points (the sinks'
 * `chars` arrays). An unclosed fence extends to the end of the text.
 */
export function fenceRegions(chars: readonly string[]): FenceRegion[] {
  const regions: FenceRegion[] = [];
  let lineStart = 0;
  let open: number | null = null;
  for (let i = 0; i <= chars.length; i++) {
    if (i === chars.length || chars[i] === "\n") {
      const line = chars.slice(lineStart, i).join("");
      if (open === null) {
        if (FENCE_OPEN_LINE.test(line)) open = lineStart;
      } else if (FENCE_CLOSE_LINE.test(line)) {
        // Include the closing fence line and its trailing newline.
        regions.push({
          start: open,
          end: Math.min(i + 1, chars.length),
          closed: true,
        });
        open = null;
      }
      lineStart = i + 1;
    }
  }
  if (open !== null) {
    regions.push({ start: open, end: chars.length, closed: false });
  }
  return regions;
}

export type PacingDecision =
  | { readonly kind: "emit"; readonly multiplier: number }
  | { readonly kind: "hold" };

/** Boundary-aware hold floor: the hold never retreats below this fraction of
 *  the text looking for a clause boundary (a too-early hold would starve the
 *  visible stream). Below it, the raw fraction index applies. */
export const HOLD_MIN_FRACTION = 0.5;

/**
 * Where a verdict-pending stream holds. The raw `HOLD_AT` fraction lands
 * anywhere — including MID-WORD, which on a short reply reads as the stream
 * being STUCK (user report 2026-07-04: 22 chars → hold at char 20, freezing
 * "…你可以|讲。" across the whole supervisor round-trip). When `chars` is
 * provided, the hold retreats to the nearest clause boundary (right after
 * punctuation or a newline) at or below the fraction index, so the freeze
 * reads as a natural between-clauses pause and the tail arrives as a whole
 * clause. No boundary at/above `HOLD_MIN_FRACTION` → the fraction index
 * stands. Always keeps ≥1 char gated behind the verdict (total-1 clamp).
 *
 * `mode` selects the boundary set: `cjk` retreats to a CJK clause boundary
 * (newline or 。，…), `word` retreats to a unit boundary — right after an
 * inline space / newline, or adjacent to a CJK glyph (each CJK code point is
 * its own reveal unit, so any CJK-adjacent index is glyph-complete) — so an
 * EN hold lands BETWEEN units, never mid-word/mid-glyph.
 *
 * Word mode only: when the band [HOLD_MIN_FRACTION, HOLD_AT] is one unbroken
 * ASCII run (a long URL / identifier), the retreat finds nothing and the raw
 * fraction would freeze MID-TOKEN for the whole supervisor round-trip — so
 * scan FORWARD past HOLD_AT for the next boundary instead (holding later is
 * safe; the ≥1-char clamp still gates the tail). cjk mode keeps the original
 * fraction fallback byte-identically.
 */
export function holdIndexFor(
  total: number,
  chars?: readonly string[],
  mode: PacingMode = "cjk",
): number {
  const fractionIndex = Math.min(Math.floor(total * HOLD_AT), total - 1);
  if (chars === undefined) return fractionIndex;
  const isBoundaryAt = (i: number): boolean => {
    const prev = chars[i - 1];
    if (prev === undefined) return false;
    return mode === "word"
      ? prev === "\n" ||
          isInlineSpace(prev) ||
          isCjkPacingChar(prev) ||
          isCjkPacingChar(chars[i])
      : prev === "\n" || PAUSE_PUNCTUATION.has(prev);
  };
  const floor = Math.ceil(total * HOLD_MIN_FRACTION);
  for (let i = fractionIndex; i >= floor && i >= 1; i--) {
    if (isBoundaryAt(i)) return i;
  }
  if (mode === "word") {
    for (let i = fractionIndex + 1; i <= total - 1; i++) {
      if (isBoundaryAt(i)) return i;
    }
  }
  return fractionIndex;
}

/**
 * Shared slow-stream pacing policy (SPEC 2026-06-11 stream-pacing §3.1).
 * Both sinks (BusActorStreamingSink for the GUI, NarrativeRenderer for the
 * CLI) consult this before emitting the character at `cursor`; each applies
 * the multiplier to its OWN base delay (the GUI and CLI sinks have different
 * base cadences; Tasks 2/3 wire them).
 *
 * - Verdict resolved (or absent — unsupervised streams pass
 *   verdictResolved: true): always emit at 1x. No ramp, no hold. After the
 *   verdict, fastForward simply resumes normal cadence (exits the hold/ramp)
 *   — the user must not perceive the verdict as a speed change.
 * - Verdict pending: 1x before RAMP_START, linear ramp to
 *   RAMP_MAX_MULTIPLIER across [RAMP_START, HOLD_AT), hold at/after the
 *   hold index. The hold index is clamped to total-1 so even tiny texts
 *   keep at least one character gated behind the verdict; when `chars` is
 *   provided it retreats to a clause boundary (see holdIndexFor) so the
 *   hold never freezes mid-word.
 *
 * A hold is exited ONLY by the controller's terminal methods — the actor
 * always calls fastForward (OK / fail-soft) or cancelAndBackspace (veto)
 * once the supervisor stream ends, so a hold cannot deadlock.
 */
export function pacingDecision(args: {
  readonly cursor: number;
  readonly total: number;
  readonly verdictResolved: boolean;
  /** The full char array being revealed. Optional (older callers omit it);
   *  enables the boundary-aware hold. */
  readonly chars?: readonly string[];
  /** Reveal granularity — MUST match the sink's emit granularity so the hold
   *  boundary the sink clamps to is the SAME index this decision holds at.
   *  Omitted → `cjk` (byte-identical for zh and every existing caller). */
  readonly mode?: PacingMode;
}): PacingDecision {
  const { cursor, total, verdictResolved, chars, mode = "cjk" } = args;
  if (verdictResolved || total <= 0) return { kind: "emit", multiplier: 1 };
  const holdIndex = holdIndexFor(total, chars, mode);
  // The snap from ramp-max to hold is intentional — the ramp has already preconditioned the reader for the pause.
  if (cursor >= holdIndex) return { kind: "hold" };
  const progress = cursor / total;
  if (progress < RAMP_START) return { kind: "emit", multiplier: 1 };
  const band = (progress - RAMP_START) / (HOLD_AT - RAMP_START);
  return { kind: "emit", multiplier: 1 + band * (RAMP_MAX_MULTIPLIER - 1) };
}
