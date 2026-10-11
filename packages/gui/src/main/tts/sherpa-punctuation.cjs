// Text → what sherpa's Kokoro frontend should see, for a Chinese unit
// (ADR 0042 §4b.2).
//
// sherpa splits text into "Chinese" and "non-Chinese" runs by the CJK range
// [一-鿿] and renders every run as its own model sequence; short pieces are
// merged into the one before them. A sentence with two commas became three
// short renders with short-sequence style rows — the bright, noisy sound
// the owner heard — and an English word in a Chinese sentence went through
// espeak, whose phoneme conventions differ from the misaki frontend the
// model was trained on (ɚ dropped, length marks added, diphthongs split).
//
// The model was trained on whole sentences: Chinese, then a space token,
// then an English word's phonemes, then a space token, then Chinese; "," "."
// "?" inside the sequence, each followed by a space token; "——" as dash
// tokens. sherpa concatenates lexicon rows verbatim, so ideographs from
// the unused tail of the CJK block (which no real text contains) can carry
// exactly those tokens when the lexicon maps them so:
//   - ten punctuation rows (hard-coded here and in the voice repo's
//     regenerate_lexicon_zh.py — the two must agree);
//   - a space row, a dash row, and one row per English phoneme symbol,
//     which the generator assigns from the pool and this module READS BACK
//     from the lexicon's leading rows (nothing else is hard-coded twice).
// The mapper then swaps punctuation for its ideographs, every space for the
// space ideograph, dashes for the dash ideograph, and every Latin word the
// bundle's lexicon-us-en.txt knows for its phonemes spelled in ideographs.
// The run stays Chinese, the sequence stays whole, and the tokens are the
// ones misaki would have produced — except the "/" before each mark, which
// sherpa's verbatim concatenation cannot drop. Words the English lexicon
// lacks stay Latin and take sherpa's espeak path as before.
//
// Plain CJS: required by tts-worker.cjs as a sibling (emitted beside it by
// electron.vite.config.ts) and by scripts/voice-lab.mjs.
"use strict";

/** placeholder ideograph → the token symbols its lexicon row carries */
const PLACEHOLDERS = Object.freeze({
  鿠: ", ␣",
  鿡: ". ␣",
  鿢: "? ␣",
  鿣: "! ␣",
  鿤: "; ␣",
  鿥: ": ␣",
  鿦: "…",
  // sentence enders at the very END of a unit: no trailing space (misaki
  // strips it), so the sequence ends on the mark as in training
  鿧: ".",
  鿨: "?",
  鿩: "!",
});

/** full-width marks: always Chinese prose, always substituted */
const FULLWIDTH = Object.freeze({
  "，": "鿠",
  "、": "鿠",
  "。": "鿡",
  "？": "鿢",
  "！": "鿣",
  "；": "鿤",
  "：": "鿥",
  "…": "鿦",
});

/** ASCII marks: substituted only directly after a CJK-range character (a
 *  Chinese character, or an English word already spelled in ideographs), so
 *  `v1.2`, `src.ts` and untranslated English clauses keep theirs. */
const ASCII = Object.freeze({
  ",": "鿠",
  ".": "鿡",
  "?": "鿢",
  "!": "鿣",
  ";": "鿤",
  ":": "鿥",
});

/** mid-text ender → its end-of-unit form */
const FINAL = Object.freeze({ 鿡: "鿧", 鿢: "鿨", 鿣: "鿩" });

const SPACE_SYMBOL = "␣";
const DASH_SYMBOL = "—";
const FULLWIDTH_RE = /[，、。？！；：…]/g;
const ASCII_AFTER_CJK_RE = /([一-鿿])([,.?!;:])/g;
const DASH_RE = /[—–]/g;
const LATIN_WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
const CJK_RE = /[一-鿿]/;

/** The punctuation half alone — what a unit looks like to sherpa when the
 *  bundle's lexicon carries the punctuation rows but no phoneme rows. */
function toSherpaText(text) {
  return finishEnder(
    String(text)
      .trim()
      .replace(FULLWIDTH_RE, (m) => FULLWIDTH[m])
      .replace(ASCII_AFTER_CJK_RE, (_, c, p) => c + ASCII[p]),
  );
}

function finishEnder(s) {
  const last = s.slice(-1);
  return FINAL[last] !== undefined ? s.slice(0, -1) + FINAL[last] : s;
}

/** The lexicon's leading placeholder rows: ideograph → symbols. Real rows
 *  end in the "/" boundary token; placeholder rows never contain it. */
function parsePlaceholderRows(lexiconZhText) {
  const rows = new Map();
  const lines = String(lexiconZhText).slice(0, 8192).split("\n");
  for (const line of lines) {
    const parts = line.trim().split(" ");
    const word = parts[0];
    if (word === undefined || word === "" || [...word].length !== 1) break;
    const syms = parts.slice(1);
    if (syms.length === 0 || syms.includes("/")) break;
    rows.set(word, syms.join(" "));
  }
  return rows;
}

/** True when a lexicon-zh.txt carries the ten punctuation rows, verbatim,
 *  among its leading rows (sherpa keeps a word's FIRST pronunciation). */
function lexiconHasPlaceholders(lexiconZhText) {
  const rows = parsePlaceholderRows(lexiconZhText);
  return Object.entries(PLACEHOLDERS).every(
    ([ch, syms]) => rows.get(ch) === syms,
  );
}

/** word → phoneme symbols, from lexicon-us-en.txt (first row wins, keys
 *  lower-cased — sherpa lower-cases too). */
function parseEnglishLexicon(lexiconEnText) {
  const map = new Map();
  for (const line of String(lexiconEnText).split("\n")) {
    const i = line.indexOf(" ");
    if (i <= 0) continue;
    const word = line.slice(0, i).toLowerCase();
    if (!map.has(word))
      map.set(
        word,
        line
          .slice(i + 1)
          .trim()
          .split(" "),
      );
  }
  return map;
}

/**
 * Build the mapper for a bundle. `punctuation` says the punctuation rows are
 * there (the worker substitutes nothing without them); `english` says the
 * phoneme, space and dash rows AND an English lexicon are there too.
 */
function createSherpaTextMapper(opts) {
  const rows = parsePlaceholderRows(opts.lexiconZhText ?? "");
  const punctuation = Object.entries(PLACEHOLDERS).every(
    ([ch, syms]) => rows.get(ch) === syms,
  );
  let space = null;
  let dash = null;
  const phone = new Map();
  for (const [ch, syms] of rows) {
    if (ch in PLACEHOLDERS) continue;
    if (syms === SPACE_SYMBOL) space = ch;
    else if (syms === DASH_SYMBOL) dash = ch;
    else if (!syms.includes(" ")) phone.set(syms, ch);
  }
  const english =
    typeof opts.lexiconEnText === "string" && opts.lexiconEnText !== ""
      ? parseEnglishLexicon(opts.lexiconEnText)
      : null;
  const fullEnglish =
    punctuation && space !== null && phone.size > 0 && english !== null;

  /** An English word as ideographs, or null when the lexicon or a symbol
   *  is missing (then the word stays Latin for sherpa's espeak path). */
  const spell = (word) => {
    if (!fullEnglish) return null;
    const syms =
      english.get(word.toLowerCase()) ??
      english.get(word.toLowerCase().replace("’", "'"));
    if (syms === undefined) return null;
    let out = "";
    for (const s of syms) {
      const ch = phone.get(s);
      if (ch === undefined) return null;
      out += ch;
    }
    return out;
  };

  function map(text) {
    let s = String(text).trim();
    if (!punctuation) return s;
    if (fullEnglish) {
      // English words the bundle can pronounce, spelled in ideographs and
      // set off by the space token as misaki does; the rest stays Latin.
      s = s.replace(LATIN_WORD_RE, (w, offset, whole) => {
        const spelled = spell(w);
        if (spelled === null) return w;
        const before = whole[offset - 1];
        const after = whole[offset + w.length];
        const lead = before !== undefined && CJK_RE.test(before) ? space : "";
        const trail = after !== undefined && CJK_RE.test(after) ? space : "";
        return lead + spelled + trail;
      });
      if (dash !== null) s = s.replace(DASH_RE, dash);
    }
    s = s
      .replace(FULLWIDTH_RE, (m) => FULLWIDTH[m])
      .replace(ASCII_AFTER_CJK_RE, (_, c, p) => c + ASCII[p]);
    if (fullEnglish) {
      // Every remaining space is misaki's space token (a space between two
      // Chinese words is one too); never at the ends.
      s = s
        .replace(/\s+/g, space)
        .replace(new RegExp(`^${space}+|${space}+$`, "g"), "");
      // A mark's row already carries its trailing space token.
      s = s.replace(new RegExp(`([鿠鿡鿢鿣鿤鿥])${space}`, "g"), "$1");
    }
    return finishEnder(s);
  }

  return {
    punctuation,
    english: fullEnglish,
    phonemeRows: phone.size,
    toSherpaText: map,
  };
}

module.exports = {
  PLACEHOLDERS,
  toSherpaText,
  lexiconHasPlaceholders,
  parsePlaceholderRows,
  createSherpaTextMapper,
};
