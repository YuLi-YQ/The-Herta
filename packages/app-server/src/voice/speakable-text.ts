import { stripDisplayUnsafe } from "@herta/core/text-sanitize";

/**
 * Speakable-text policy for Herta's synthesized voice (ADR 0042).
 *
 * Herta's speech blocks are prose with code in them — fenced blocks, inline
 * `identifiers`, shell lines, paths, `@板砖` dispatch tokens, markdown
 * emphasis, the odd `#E-207` — and the TTS frontend (sherpa-onnx's Kokoro
 * zh/en pipeline) will dutifully try to pronounce every one of them. This
 * module decides, deterministically and without a model, what she SAYS
 * versus what she merely SHOWS:
 *
 *   - Fenced ``` blocks and table rows are shown, never spoken (the wave
 *     engine's `scanSpeakable` already treats them as unspoken — same rule).
 *   - Inline code is spoken when it is a NAME (an identifier, a path, a
 *     filename — things she would say out loud: "read file", "parser",
 *     "src echo 点 mjs") and skipped when it is an EXPRESSION or a command
 *     (`PORT ?? 3000`, `node src/echo.mjs hello`) — she talks around code,
 *     she does not read it character by character.
 *   - Markdown scaffolding (emphasis, headers, list markers, links, quotes)
 *     is stripped; the words inside are kept.
 *   - `@板砖` / `@Brick` lose the `@`: the name is spoken, the dispatch
 *     sigil is not.
 *   - Symbols that carry no spoken form (→ = | ~ ^ emoji) become pauses or
 *     vanish; quotes and CJK brackets vanish around their contents.
 *   - In a Chinese session a sentence that still carries Latin letters after
 *     all of the above is shown, never spoken (owner, 2026-09-06: the voice
 *     was fine-tuned on single-language sentences, and the English islands
 *     did not pass the ear). The sentence types at the read-along cadence.
 *
 * Nothing is ever ADDED in her voice: the transform only deletes, splits or
 * substitutes a pronunciation for a glyph (`.` → 点/dot inside a filename).
 * Putting words in Herta's mouth that she did not write would break D3 as
 * surely as reading `??` aloud breaks it.
 *
 * The companion `segmentSpeechUnits` cuts a GROWING buffer into the units
 * the voiced reveal synthesizes one at a time — whole sentences, short ones
 * merged with the next, long ones split at clause marks. Both are pure.
 */

export type SpeechLang = "zh" | "en";

/**
 * One synthesis unit: a span of the ORIGINAL text (code-point indices, end
 * exclusive — the reveal emits exactly these characters) plus the text the
 * synthesizer receives, or "" for a silent unit (code, table, a Latin
 * fragment in a Chinese session, nothing pronounceable left).
 */
export interface SpeechUnit {
  readonly start: number;
  readonly end: number;
  readonly speak: string;
}

// ── Unit segmentation ───────────────────────────────────────────────────────

/** Sentence enders that close a unit. The CJK enders (。！？) close
 *  unconditionally; the ASCII ones (. ! ?) close only before whitespace or
 *  end of input, so `0.1.2`, `src/main.ts` and `node x.mjs` are not sentence
 *  breaks — that gate lives in `scanSentence`. */
const HARD_END: ReadonlySet<string> = new Set([
  "。",
  "！",
  "？",
  ".",
  "!",
  "?",
]);
/** Clause punctuation a long sentence may be split at. */
const CLAUSE_END: ReadonlySet<string> = new Set([
  "，",
  "、",
  "；",
  "：",
  ",",
  ";",
  ":",
]);
/** Closers that belong to the unit whose ender they follow (`。”` `？）`). */
const TRAILING_CLOSER: ReadonlySet<string> = new Set([
  "”",
  "’",
  "」",
  "』",
  "）",
  ")",
  "]",
  "］",
  "》",
  '"',
  "'",
]);

/**
 * A sentence shorter than this (code points of the shown text) is not a unit
 * on its own: it merges with the sentence that follows, so 「嗯。我知道。」 is
 * one utterance and not two clipped ones (owner, 2026-09-06). The last
 * sentence of a reply closes regardless.
 */
export const MIN_UNIT_CHARS = 10;
/** A sentence (or a merged run) longer than this splits at its clause marks
 *  into pieces of at most this length; a tail shorter than MIN_UNIT_CHARS
 *  stays with the piece before it. */
export const SOFT_MAX_UNIT_CHARS = 48;
/** Past this length a run with no ender in sight cuts anyway — at its last
 *  clause mark, else its last word boundary (Kokoro's 510-token ceiling is
 *  far above it; this bounds per-unit synthesis latency on a slow CPU). */
export const HARD_MAX_UNIT_CHARS = 80;

/** Latin letters left in the SPOKEN text of a Chinese unit: not her voice. */
const LATIN_RE = /[A-Za-z]/;

function isWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isFenceLine(line: string): boolean {
  return /^\s*```/.test(line);
}

function isTableLine(line: string): boolean {
  return /^\s*\|/.test(line);
}

/** One sentence-shaped scan result: where it ends (exclusive), why, and the
 *  clause-mark positions inside it (exclusive ends, outside inline code). */
interface Scan {
  readonly end: number;
  /** `sentence`: an ender closed it; `line`: a newline; `cap`: the hard cap. */
  readonly kind: "sentence" | "line" | "cap";
  readonly clauses: readonly number[];
}

/**
 * Walk prose from `from` to the next sentence boundary. Returns null while
 * the sentence is still open (no ender yet, or an ender whose follower —
 * a possible closer — has not arrived and input is not finished).
 */
function scanSentence(
  chars: readonly string[],
  from: number,
  finished: boolean,
): Scan | null {
  const n = chars.length;
  const clauses: number[] = [];
  let j = from;
  let lastClause = -1;
  /** Last word boundary seen — the hard cap's fallback cut point. */
  let lastSpace = -1;
  /**
   * Inside an inline `code` span. Punctuation there is CODE, not prose:
   * splitting on it breaks the backtick pair across two units, and each
   * half then reads as literal text — `PORT ?? 3000` became "不过 `PORT?"
   * and "3000` 那个…", which the synthesizer would happily pronounce
   * (voice lab, first run). A span still open at the end of the buffer
   * behaves like an unclosed fence: the unit waits for more input.
   */
  let inCode = false;
  const cap = (): Scan => ({
    // Prefer a clause mark, then a WORD boundary, and only then cut where
    // we stand. The word boundary matters for English, where a long
    // sentence can carry no clause mark at all: cutting at the raw cap
    // split "war room" into "…war" / "room …" and "news?" into "ews?",
    // and each half was synthesized as its own utterance (voice lab).
    end: lastClause > from ? lastClause : lastSpace > from ? lastSpace : j + 1,
    kind: "cap",
    clauses,
  });
  while (j < n) {
    const ch = chars[j] as string;
    if (ch === "`") {
      inCode = !inCode;
      j += 1;
      continue;
    }
    if (ch === "\n") {
      // A newline ends the unit AND any inline span — an unterminated
      // backtick never swallows the rest of the reply.
      return { end: j + 1, kind: "line", clauses };
    }
    if (inCode) {
      // Still bound by the hard cap, so a pathological unclosed span
      // cannot grow a unit without limit.
      if (j + 1 - from >= HARD_MAX_UNIT_CHARS) return cap();
      j += 1;
      continue;
    }
    if (HARD_END.has(ch)) {
      // EN enders need a following space/newline/end (3.5, v0.1.2 —
      // decimals and versions are not sentence ends). CJK enders never do.
      const cjkEnder = ch === "。" || ch === "！" || ch === "？";
      const after = chars[j + 1];
      const endsHere =
        cjkEnder || isWhitespace(after) || (after === undefined && finished);
      if (endsHere) {
        // Absorb closers, then a look-ahead: we need to SEE the next real
        // character (or end of input) before the sentence can close.
        let k = j + 1;
        while (k < n && TRAILING_CLOSER.has(chars[k] as string)) k += 1;
        if (k >= n && !finished) return null;
        return { end: k, kind: "sentence", clauses };
      }
    }
    if (CLAUSE_END.has(ch)) {
      lastClause = j + 1;
      clauses.push(j + 1);
    }
    if (isWhitespace(ch)) lastSpace = j + 1;
    if (j + 1 - from >= HARD_MAX_UNIT_CHARS) return cap();
    j += 1;
  }
  return null;
}

/**
 * Cut `chars` (the growing code-point buffer) into CLOSED units, in order.
 * Prefix-stable: once a unit has closed it never changes as more text
 * arrives, so an incremental caller can synthesize units as they close.
 * The units are sentences:
 *   - a sentence closes at an ender followed by a character that is not a
 *     closer (so `。”` stays whole) — or by end of input when `finished`;
 *   - a sentence shorter than MIN_UNIT_CHARS merges with the one that
 *     follows (it waits for it); the reply's last sentence closes as is;
 *   - a sentence (or merged run) longer than SOFT_MAX_UNIT_CHARS splits at
 *     its clause marks (and inner sentence ends) into pieces of at most
 *     that length, never leaving a tail under MIN_UNIT_CHARS;
 *   - a newline ends a unit regardless of length (each line is its own
 *     unit; blank lines attach to the previous unit's tail);
 *   - a fenced block is ONE silent unit, a table row too;
 *   - a run past HARD_MAX_UNIT_CHARS with no ender cuts at its last clause
 *     mark or word boundary;
 *   - in a Chinese session, a sentence whose spoken text still carries
 *     Latin letters is its own SILENT unit — never merged into a neighbour,
 *     so the short sentence before it is still spoken;
 *   - input finishing closes whatever is pending.
 * Trailing whitespace after an ender is absorbed into the unit that ended,
 * so the next unit starts on a real character.
 */
export function segmentSpeechUnits(
  chars: readonly string[],
  finished: boolean,
  lang: SpeechLang = "zh",
): SpeechUnit[] {
  const units: SpeechUnit[] = [];
  const n = chars.length;
  const push = (start: number, end: number, silent = false): void => {
    if (end <= start) return;
    const raw = chars.slice(start, end).join("");
    units.push({
      start,
      end,
      speak: silent ? "" : toSpeakableText(raw, lang),
    });
  };
  /** Push [start, end) as one unit, or as clause-bounded pieces when long. */
  const flush = (
    start: number,
    end: number,
    clauses: readonly number[],
  ): void => {
    if (end - start <= SOFT_MAX_UNIT_CHARS) {
      push(start, end);
      return;
    }
    const cuts: number[] = [];
    let pieceStart = start;
    let lastGood = -1;
    for (const c of clauses) {
      if (c <= pieceStart || c >= end) continue;
      if (c - pieceStart > SOFT_MAX_UNIT_CHARS && lastGood > pieceStart) {
        cuts.push(lastGood);
        pieceStart = lastGood;
      }
      lastGood = c;
    }
    if (end - pieceStart > SOFT_MAX_UNIT_CHARS && lastGood > pieceStart) {
      cuts.push(lastGood);
      pieceStart = lastGood;
    }
    // No clipped tail: a remainder under the minimum rides with its
    // predecessor even if that piece then exceeds the soft cap a little.
    if (cuts.length > 0 && end - pieceStart < MIN_UNIT_CHARS) cuts.pop();
    let from = start;
    for (const cut of cuts) {
      // Whitespace after a clause mark belongs to the piece that ended.
      let to = cut;
      while (to < end && isWhitespace(chars[to])) to += 1;
      push(from, to);
      from = to;
    }
    push(from, end);
  };

  let i = 0;
  /** Start of the pending unit — earlier than `i` while short sentences
   *  wait for the one that follows. */
  let unitStart = 0;
  /** Clause marks and inner sentence ends inside the pending unit. */
  let clauses: number[] = [];
  while (i < n) {
    // Line-shaped units: a fence block or a table row, judged at line start
    // (a newline closes every unit, so nothing is pending here).
    if (unitStart === i && (i === 0 || chars[i - 1] === "\n")) {
      const lineEnd = indexOfLineEnd(chars, i);
      const line = chars.slice(i, lineEnd).join("");
      if (isFenceLine(line)) {
        // Find the closing fence line. Unclosed → closes only when input
        // finishes (the reveal holds, as the fence rule already does).
        let j = lineEnd;
        let closed = false;
        while (j < n) {
          if (chars[j] !== "\n") {
            j += 1;
            continue;
          }
          const nextEnd = indexOfLineEnd(chars, j + 1);
          const next = chars.slice(j + 1, nextEnd).join("");
          if (/^\s*```\s*$/.test(next)) {
            j = nextEnd < n ? nextEnd + 1 : nextEnd; // through its newline
            closed = true;
            break;
          }
          j += 1;
        }
        if (!closed) {
          if (!finished) break;
          j = n;
        }
        push(i, j, true);
        i = j;
        unitStart = i;
        continue;
      }
      if (isTableLine(line)) {
        if (lineEnd >= n && !finished) break;
        const end = lineEnd < n ? lineEnd + 1 : n;
        push(i, end, true);
        i = end;
        unitStart = i;
        continue;
      }
    }
    // Prose: the next sentence.
    let scan = scanSentence(chars, i, finished);
    if (scan === null) {
      if (!finished) break; // still open — wait for more input
      scan = { end: n, kind: "sentence", clauses: [] };
    }
    // A Latin fragment in a Chinese session: the sentence is shown, not
    // spoken — on its own, so a short sentence pending before it still gets
    // its voice.
    const latin =
      lang === "zh" &&
      LATIN_RE.test(toSpeakableText(chars.slice(i, scan.end).join(""), lang));
    if (latin) {
      if (unitStart < i) flush(unitStart, i, clauses);
      let end = scan.end;
      while (end < n && isWhitespace(chars[end])) end += 1;
      if (end >= n && !finished && scan.end < n) break; // hold (see below)
      push(i, end, true);
      i = end;
      unitStart = i;
      clauses = [];
      continue;
    }
    clauses.push(...scan.clauses);
    const closes =
      scan.kind !== "sentence" ||
      scan.end - unitStart >= MIN_UNIT_CHARS ||
      (scan.end >= n && finished);
    if (!closes) {
      // Too short to stand alone: merge with the sentence that follows.
      if (scan.end >= n) break; // nothing follows yet — wait
      clauses.push(scan.end);
      i = scan.end;
      continue;
    }
    // Absorb trailing whitespace so the next unit starts on a character —
    // but only what is already KNOWN; an open tail waits for input.
    let end = scan.end;
    while (end < n && isWhitespace(chars[end])) end += 1;
    if (end >= n && !finished && scan.end < n) {
      // Trailing whitespace reaches the open end: hold until we know what
      // follows (a newline may still be coming).
      break;
    }
    flush(unitStart, end, clauses);
    i = end;
    unitStart = i;
    clauses = [];
  }
  return units;
}

function indexOfLineEnd(chars: readonly string[], from: number): number {
  let k = from;
  while (k < chars.length && chars[k] !== "\n") k += 1;
  return k;
}

// ── Speakable transform ─────────────────────────────────────────────────────

/** Leading/whole `〔…〕` hint scaffolding and every stray narrative tag:
 *  never her voice (see @herta/herta block-shape / strip-stray-open-tags). */
const SCAFFOLDING_RE = /〔[^〕]*〕/gu;
const STRAY_TAG_RE = /（\/?(?:我 说|我 想|开拓者 说)）/gu;

/** An inline-code body she would SAY: one name-like token — identifier,
 *  filename, path, dotted or hyphenated, or the `@板砖` dispatch name — no
 *  spaces, no operators. */
const NAME_LIKE_RE = /^@?[\p{L}\p{N}_$.\-/\\:]{1,48}$/u;
/** A bare path/filename outside backticks (`scripts/merge_sort.py`,
 *  `parser.ts`, `src/main.ts`). Requires a separator or a known-looking
 *  extension so ordinary words never match. */
const BARE_PATH_RE =
  /(?<![\p{L}\p{N}_./\\-])(?:[\w.-]+(?:[/\\][\w.-]+)+|[\w-]+\.(?:[a-z]{1,5}))(?![\p{L}\p{N}_./\\-])/gu;
const URL_RE = /\bhttps?:\/\/\S+/giu;
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/gu;
const LINK_RE = /\[([^\]]+)\]\([^)]*\)/gu;
/** Emoji and other symbols, with any trailing variation selector. Written as
 *  an ALTERNATION rather than a character class: U+FE0F is a combining
 *  character, and inside a class it would pair with the preceding member to
 *  form a new character (biome noMisleadingCharacterClass). */
const PICTOGRAPH_RE = /(?:[\p{Extended_Pictographic}\p{So}]️?|️)/gu;

/** Pronounce a name-like token: separators become spaces, the dot before an
 *  extension is read (点 / dot), camelCase splits so espeak gets words. */
function pronounceName(token: string, lang: SpeechLang): string {
  const dot = lang === "zh" ? " 点 " : " dot ";
  // Leading `@` (the `@板砖` dispatch name), `$`, `.` carry no spoken form.
  let t = token.replace(/^[@$.]+/, "");
  // Leading `./` `../` carry no spoken form.
  t = t.replace(/^(?:\.{1,2}[/\\])+/, "");
  t = t.replace(/[/\\:]+/g, " ");
  t = t.replace(/_+/g, " ");
  t = t.replace(/-+/g, " ");
  // `a.b` between word characters → a 点 b; a lone trailing dot vanishes.
  t = t.replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, dot);
  t = t.replace(/\.+/g, " ");
  // camelCase / PascalCase → camel Case (ASCII only — CJK has no case).
  t = t.replace(/([a-z\d])([A-Z])/g, "$1 $2");
  return t.replace(/\s+/g, " ").trim();
}

/** True when an inline-code body should be spoken (a name) rather than
 *  skipped (an expression / command). */
export function isSpeakableCode(body: string): boolean {
  const b = body.trim();
  if (b.length === 0) return false;
  return NAME_LIKE_RE.test(b);
}

/**
 * The text the synthesizer receives for one unit of Herta's prose, or ""
 * when nothing pronounceable remains. Pure; idempotent on plain prose
 * (ordinary Chinese / English sentences come back unchanged apart from
 * whitespace collapse). The Latin-fragment rule is the SEGMENTER's, not
 * this transform's: this function keeps a spoken name so the segmenter can
 * see it and silence the sentence.
 */
export function toSpeakableText(raw: string, lang: SpeechLang = "zh"): string {
  let t = stripDisplayUnsafe(raw).replace(/\r\n?/g, "\n");
  // Whole-unit non-speech shapes first.
  if (/^\s*```/.test(t) || /^\s*\|/.test(t)) return "";
  t = t.replace(SCAFFOLDING_RE, " ").replace(STRAY_TAG_RE, " ");
  // Images vanish; links keep their text; URLs vanish.
  t = t.replace(IMAGE_RE, " ").replace(LINK_RE, "$1").replace(URL_RE, " ");
  // Inline code: a name is pronounced, an expression is skipped.
  t = t.replace(/`([^`\n]*)`/g, (_m, body: string) =>
    isSpeakableCode(body) ? ` ${pronounceName(body.trim(), lang)} ` : " ",
  );
  // The dispatch sigil is not spoken; the name is.
  t = t.replace(/@(板砖|Brick)/g, "$1");
  // Markdown scaffolding, line by line.
  t = t
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, ""),
    )
    .join("\n");
  t = t.replace(/\*\*|__|~~/g, "").replace(/\*/g, "");
  // Bare paths / filenames in prose read like names.
  t = t.replace(BARE_PATH_RE, (m) => ` ${pronounceName(m, lang)} `);
  // `#E-207` → E-207 (the hash is layout); lone hashes vanish.
  t = t.replace(/#(?=[\p{L}\p{N}])/gu, "").replace(/#/g, " ");
  // Pauses for arrows; nothing for the rest of the operator set.
  t = t.replace(/[→⇒➜↦]/g, lang === "zh" ? "，" : ", ");
  t = t.replace(/[←⇐]/g, " ");
  t = t.replace(/[=<>|~^&+*$]/g, " ");
  t = t.replace(/\//g, " ");
  // Any backtick that survived the inline-code pass is UNPAIRED (a span the
  // model never closed). Defensive: the segmenter keeps pairs whole, but a
  // stray one must never be pronounced.
  t = t.replace(/`/g, " ");
  // Quotes and CJK brackets vanish around their contents — EXCEPT an
  // apostrophe between letters, which is a contraction and part of the word.
  // Stripping it turned "didn't" into "didnt" and, worse, "I'll" into "Ill"
  // (voice lab, EN transcripts): espeak reads that as the adjective.
  // An apostrophe is kept only BETWEEN two letters; either alternative below
  // matches everywhere else (an opening or closing single quote, a trailing
  // possessive), so those still vanish.
  t = t.replace(/(?<![\p{L}])['’]|['’](?![\p{L}])/gu, "");
  t = t.replace(/[“”‘"「」『』【】《》〈〉]/g, "");
  t = t.replace(PICTOGRAPH_RE, "");
  // Repeated marks collapse; the model reads one pause, not a stutter.
  t = t
    .replace(/…{2,}/g, "…")
    .replace(/\.{3,}/g, "…")
    .replace(/([。！？!?])\1+/g, "$1")
    .replace(/——+/g, "——");
  // Whitespace: newlines become a pause-carrying space; runs collapse.
  t = t.replace(/\s+/g, " ").trim();
  // A unit that lost its opening content keeps no dangling clause mark.
  t = t
    .replace(/^[，、；：,;:\s]+/, "")
    .replace(/\s+([，。！？；：、,.!?;:])/g, "$1");
  // A CJK punctuation mark needs no following space (a substitution — inline
  // code, an arrow → ，— may have introduced one). ASCII punctuation keeps
  // its space so English words stay separated. Cosmetic for the synthesizer,
  // deterministic for the record.
  //
  // The em dash is deliberately NOT in this set: it is used in BOTH scripts,
  // and collapsing after it welded English words together ("room — Did" →
  // "room —Did", voice lab). Chinese writes ——  without spaces anyway, so
  // leaving it alone costs nothing there.
  t = t.replace(/([，。！？；：、…])\s+/g, "$1");
  // Nothing pronounceable → silent (a "……" line, a bracket-only line).
  if (!/[\p{L}\p{N}]/u.test(t)) return "";
  return t;
}
