/**
 * Dream parse + 废案-validation property fuzz (2026-07-09). Two trust
 * boundaries meet here:
 *
 *   1. `jsonCall` is the seam between an untrusted LLM reply and the pass:
 *      a successful transport that returns unparseable content must degrade to
 *      a MODEL-QUALITY failure (undefined) the caller may consume, while a
 *      transport failure must surface as a distinct typed error so the episode
 *      is retried, not silently archived. No raw string may make it throw.
 *
 *   2. `validateFeian` is the gate on dream-authored 废案. Whatever it accepts
 *      is written to `.herta/narrative/` and later loaded VERBATIM into the
 *      static Herta prefix as a few-shot (static-prefix.ts — no ZWSP sanitize,
 *      unlike escapeUserText/sanitizeActorText). So an accepted body IS prompt
 *      ground truth: its structural guarantees are the only thing standing
 *      between a hostile distillation and a poisoned prefix.
 *
 * NOTE on scope of the "no live marker" completeness claim. The 废案 grammar
 * DELIBERATELY reuses the envelope glyphs （我 说）/（开拓者 说）/（我 想） as its
 * dialogue fences — validateFeian REQUIRES a （我 说） block and REQUIRES every
 * fence to nest. So an accepted body always carries those markers on purpose;
 * the separation of few-shot-example markers from live-record markers is
 * POSITIONAL (the `### 废案` header delimits the example), not a ZWSP break.
 * The provable forge-safety invariant is therefore "all fences BALANCED (no
 * dangling half-open marker that could swallow following prefix text) + no
 * invisible/control codepoint", NOT "no marker glyph present".
 *
 * Invariants:
 *   J1a. validateFeian never throws, for any input; always returns the
 *        {ok:true} | {ok:false,errors:string[]} shape.
 *   J1b. jsonCall never throws on ANY rawJsonText (garbage, ```json fences,
 *        truncated/partial JSON, wrong types, deeply nested, huge, embedded
 *        NUL/control, injection payloads); it resolves to a value or undefined.
 *   J1c. jsonCall maps a client (transport) throw to DreamTransportError — the
 *        parse-failure (undefined) and transport-failure (throw) paths stay
 *        distinct.
 *   J2a. ok:true ⟹ no invisible/control codepoint anywhere (BAD_RANGES).
 *   J2b. ok:true ⟹ MIN_CHARS ≤ length and estimated tokens ≤ the load
 *        gate's cap; both exact at the boundary (59↔60 chars, 10000↔10001
 *        estimated tokens). The ceiling is in tokens, not chars (ADR 0014
 *        §6, amended 2026-09-23).
 *   J2c. ok:true ⟹ no leaked English structural marker (Verdict:/Changed:/…).
 *   J2d. ok:true ⟹ line-1 header parses AND its title carries no western
 *        digit-run / file-ext token / multi-segment path (one-off identifiers).
 *   J2e. ok:true ⟹ a `---` separator and at least one （我 说） are present.
 *   J3.  Determinism: validateFeian(x) equals a second call on the same x.
 *   J4.  Forge-safety completeness: ok:true ⟹ every dialogue fence is balanced
 *        (checkFences ⇒ null) — no accepted few-shot leaves a half-open marker.
 *   J5.  Poison-flips-false: injecting a guaranteed-bad atom (an invisible
 *        codepoint, or a line-anchored English marker) into a valid 废案 always
 *        forces ok:false — the checks scan the whole text, no position escapes.
 */
import { estimatePromptTokens, stripDisplayUnsafe } from "@herta/core";
import { describe, expect, it } from "vitest";
import type { DeepSeekChatResponse, DeepSeekClient } from "../llm/types.js";
import { validateFeian } from "./feian-format.js";
import { DreamTransportError, jsonCall } from "./llm-json.js";

// Deterministic PRNG (no Math.random — reproducible failures).
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Independent re-derivation of the validator's own predicates ──────────
// Copied VERBATIM from feian-format.ts so an accepted body can be
// cross-checked against every rule independently: this catches an internal
// OR/short-circuit bug where ok:true is returned though a check should fire.
// If any copy drifts from source the sweep goes red — that is the point.

const HEADER_RE = /^### 废案(?:_(\d{2,}))?：(.+)$/;
const MIN_CHARS = 60;
// The page's only length ceiling: `checkFewShot`'s MAX_BODY_TOKENS
// (few-shot-guard.ts), which validateFeian runs — measured as the gate
// measures it, over the display-safe text.
const MAX_EST_TOKENS = 10_000;
const estTokens = (text: string): number =>
  estimatePromptTokens(stripDisplayUnsafe(text));
// Mirrors of the source constants, kept in sync so the test's internal
// predictions match validateFeian. (The INDEPENDENT allow-set oracle below
// is what actually guards against an incomplete blacklist — this mirror is
// only for the ok:true⇒clean cross-checks.)
const LEAK_MARKERS =
  /\b(Verdict|Changed|Evidence|Summary|Risks?|Plan)\s*[:：]/i;
const TITLE_DIGITS = /\d{2,}/;
const TITLE_EXT = /\.(ts|tsx|js|jsx|py|go|rs|java|json|md|txt|html|css)\b/i;
const TITLE_PATH = /(?:[A-Za-z]:[\\/]|[\\/]\w+[\\/])/;
const BAD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x2028, 0x2029],
  [0x200b, 0x200d],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xd800, 0xdfff],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];
function hasBadCodepoint(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    for (const [lo, hi] of BAD_RANGES) if (c >= lo && c <= hi) return true;
  }
  return false;
}
/** Verbatim copy of feian-format.ts checkFences — a fresh /g per call, so no
 *  shared lastIndex leaks between the sweep's iterations. */
function checkFences(text: string): string | null {
  const tag = /（(\/?)([^（）/\s]+)\s+(说|想)）/g;
  const stack: string[] = [];
  for (let m = tag.exec(text); m !== null; m = tag.exec(text)) {
    const closing = m[1] === "/";
    const key = `${m[2]} ${m[3]}`;
    if (!closing) {
      stack.push(key);
    } else {
      const top = stack.pop();
      if (top !== key) return `unbalanced dialogue fence near （/${key}）`;
    }
  }
  return stack.length === 0 ? null : "unbalanced";
}

// ── Independent codepoint ALLOW-SET oracle (NOT derived from BAD_RANGES) ──
// J2a re-derives the source blacklist (BAD_RANGES) — a tautology that cannot
// catch an INCOMPLETE blacklist: if a hostile range is missing from source,
// the copy is missing it too, so both agree the char is fine. This oracle is
// built from FIRST PRINCIPLES instead — a positive whitelist of exactly the
// codepoint families the real seed corpus + atom corpus legitimately use.
// Any accepted body carrying a codepoint OUTSIDE this set (e.g. a future edit
// drops U+2028-2029 or the Tag block from BAD_RANGES, letting an invisible
// char through) lands out-of-allow-set and turns the sweep RED. Widen this set
// only for a codepoint the seeds genuinely use — never relax it toward a copy
// of the blacklist.
const ALLOW_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x09, 0x09], // tab
  [0x0a, 0x0a], // LF
  [0x0d, 0x0d], // CR
  [0x20, 0x7e], // printable ASCII (covers ``` fences, paths, PR-digits, etc.)
  [0xb7, 0xb7], // · middle dot (阮·梅)
  [0x2192, 0x2192], // → record-label arrow (→ 系统 / → 差分协处理器)
  [0x3000, 0x303f], // CJK symbols & punctuation (。、「」…)
  [0x4e00, 0x9fff], // CJK unified ideographs (废案 午后 说 想 系统 差分协处理器…)
  [0xff00, 0xffef], // full-width forms (（ U+FF08, ） U+FF09, ： U+FF1A, ， U+FF0C)
];
/** First codepoint in `text` outside the independent allow-set, or null. */
function firstDisallowedCodepoint(text: string): number | null {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    let allowed = false;
    for (const [lo, hi] of ALLOW_RANGES) {
      if (c >= lo && c <= hi) {
        allowed = true;
        break;
      }
    }
    if (!allowed) return c;
  }
  return null;
}

/** Assert every documented necessary condition holds whenever ok:true. */
function assertOkImpliesClean(text: string, label: string): void {
  const r = validateFeian(text);
  // J1a — shape.
  expect(typeof r.ok, `${label} :: ok not boolean`).toBe("boolean");
  if (!r.ok) {
    expect(Array.isArray(r.errors), `${label} :: errors not array`).toBe(true);
    expect(r.errors.length > 0, `${label} :: ok:false with no errors`).toBe(
      true,
    );
    return;
  }
  // J2a
  expect(
    hasBadCodepoint(text),
    `${label} :: ok:true but invisible/control codepoint present`,
  ).toBe(false);
  // J2a' — INDEPENDENT allow-set oracle (catches an incomplete blacklist that
  // J2a's re-derivation cannot). Every codepoint of an accepted body must fall
  // inside the first-principles whitelist.
  const disallowed = firstDisallowedCodepoint(text);
  expect(
    disallowed,
    `${label} :: ok:true but codepoint U+${(disallowed ?? 0).toString(16)} is outside the independent allow-set`,
  ).toBeNull();
  // J2b
  expect(
    text.length >= MIN_CHARS && estTokens(text) <= MAX_EST_TOKENS,
    `${label} :: ok:true but ${text.length} chars / ~${estTokens(text)} tokens is out of [${MIN_CHARS} chars, ${MAX_EST_TOKENS} tokens]`,
  ).toBe(true);
  // J2c
  expect(
    LEAK_MARKERS.test(text),
    `${label} :: ok:true but leaked English structural marker`,
  ).toBe(false);
  // J2e
  expect(
    /（我 说）/.test(text),
    `${label} :: ok:true but no （我 说） block`,
  ).toBe(true);
  expect(
    /^\s*---\s*$/m.test(text),
    `${label} :: ok:true but no --- separator`,
  ).toBe(true);
  // J2d — header + clean title (header is guaranteed non-null when ok:true).
  const firstNonBlank = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const m = HEADER_RE.exec(firstNonBlank.trim());
  expect(
    m,
    `${label} :: ok:true but line-1 is not a valid header`,
  ).not.toBeNull();
  if (m !== null) {
    const title = (m[2] ?? "").trim();
    expect(
      TITLE_DIGITS.test(title),
      `${label} :: ok:true but title has a digit-run: ${JSON.stringify(title)}`,
    ).toBe(false);
    expect(
      TITLE_EXT.test(title),
      `${label} :: ok:true but title has a file-ext token: ${JSON.stringify(title)}`,
    ).toBe(false);
    expect(
      TITLE_PATH.test(title),
      `${label} :: ok:true but title has a path fragment: ${JSON.stringify(title)}`,
    ).toBe(false);
  }
  // J4 — forge-safety: no half-open dialogue fence in an accepted few-shot.
  expect(
    checkFences(text),
    `${label} :: ok:true but a dialogue fence is unbalanced`,
  ).toBeNull();
}

// ── Adversarial 废案 corpus ──────────────────────────────────────────────

// Invisible / control atoms built from codepoints so the SOURCE stays
// printable ASCII (no literal control glyphs in the file).
const NUL = String.fromCodePoint(0x0000);
const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);
const BOM = String.fromCodePoint(0xfeff);

/** Atoms chosen so random concatenation frequently forms header/separator/
 *  fence structure AND collides with every forbidden family: record labels,
 *  code fences, title-leak tokens, English markers, invisible codepoints. */
const FEIAN_ATOMS = [
  "### 废案_07：午后的噪声",
  "### 废案：午后的噪声",
  "### 废案",
  "## wrong",
  "PR 3492", // title digit-run
  "改 foo.ts", // title file-ext
  "/etc/passwd", // multi-segment path
  "C:/Users/x", // windows drive path
  "2026-06-18", // ISO date (digit-run)
  "\n",
  "---",
  "（开拓者 说）",
  "（/开拓者 说）",
  "（我 说）",
  "（/我 说）",
  "（我 想）",
  "（/我 想）",
  "→ 系统", // terminal-record backend label
  "→ 差分协处理器",
  "```",
  "Verdict:",
  "Verdict：", // full-width colon — the likelier form in Chinese prose
  "Changed:",
  "Evidence:",
  "在。说吧。",
  "看了 src/foo.ts，没问题。",
  "x",
  "。",
  " ",
  ZWSP,
  NUL,
  RLO,
  BOM,
] as const;

function randomFeian(rng: () => number, maxAtoms: number): string {
  const n = Math.floor(rng() * maxAtoms);
  let s = "";
  for (let i = 0; i < n; i++) {
    s += FEIAN_ATOMS[Math.floor(rng() * FEIAN_ATOMS.length)];
  }
  return s;
}

/** A known-valid 废案 (mirrors feian-format.test.ts GOOD). */
const GOOD = [
  "### 废案_07：午后的噪声",
  "",
  "阮·梅难得主动联系我。",
  "",
  "---",
  "",
  "（开拓者 说）",
  "在吗",
  "（/开拓者 说）",
  "",
  "（我 说）",
  "在。说吧。",
  "（/我 说）",
].join("\n");

/** Splice `atom` into `base` at a random codepoint boundary. */
function inject(base: string, atom: string, rng: () => number): string {
  const chars = [...base];
  const at = Math.floor(rng() * (chars.length + 1));
  chars.splice(at, 0, atom);
  return chars.join("");
}

describe("validateFeian — property fuzz", () => {
  it("J1a·J2·J3·J4 over a random atom sweep (1000 strings)", {
    timeout: 60_000,
  }, () => {
    const rng = mulberry32(0xfea41);
    for (let i = 0; i < 1000; i++) {
      const text = randomFeian(rng, 10);
      const label = `random ${JSON.stringify(text)}`;
      // J1a — never throws.
      expect(() => validateFeian(text), `${label} threw`).not.toThrow();
      // J2/J4 — ok:true implies every documented rule holds.
      assertOkImpliesClean(text, label);
      // J3 — determinism.
      expect(
        JSON.stringify(validateFeian(text)),
        `${label} not deterministic`,
      ).toBe(JSON.stringify(validateFeian(text)));
    }
  });

  it("J2·J4 over mutated-valid 废案 (1000 strings — dense ok:true coverage)", {
    timeout: 60_000,
  }, () => {
    const rng = mulberry32(0x900d5eed);
    let okCount = 0;
    const okBodies = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      let text = GOOD;
      const injections = Math.floor(rng() * 4); // 0..3 hostile atoms
      for (let k = 0; k < injections; k++) {
        text = inject(
          text,
          FEIAN_ATOMS[Math.floor(rng() * FEIAN_ATOMS.length)] ?? "",
          rng,
        );
      }
      const label = `mutated ${JSON.stringify(text)}`;
      expect(() => validateFeian(text), `${label} threw`).not.toThrow();
      if (validateFeian(text).ok) {
        okCount++;
        okBodies.add(text);
      }
      assertOkImpliesClean(text, label);
    }
    // The seed is valid, so 0-injection cases guarantee ok:true coverage —
    // the ok-conditioned invariants above are not vacuous.
    expect(okCount, "mutated sweep produced no ok:true case").toBeGreaterThan(
      0,
    );
    // …and they are multi-sample, not ~thousands of copies of the one canonical
    // GOOD body: a handful of DISTINCT ok:true bodies must survive mutation, so
    // the ok-conditioned invariants are exercised across varied accepted text.
    expect(
      okBodies.size,
      `mutated sweep yielded only ${okBodies.size} distinct ok:true bodies`,
    ).toBeGreaterThanOrEqual(5);
  });

  it("J5 — an injected bad codepoint always forces ok:false", () => {
    const rng = mulberry32(0xbadc0de);
    for (const bad of [NUL, ZWSP, RLO, BOM]) {
      for (let i = 0; i < 200; i++) {
        const text = inject(GOOD, bad, rng);
        const r = validateFeian(text);
        const label = `bad-cp U+${bad.codePointAt(0)?.toString(16)} @ ${JSON.stringify(text)}`;
        expect(
          r.ok,
          `${label} :: accepted a body with an invisible codepoint`,
        ).toBe(false);
        if (!r.ok) {
          expect(
            r.errors.some((e) => e.includes("codepoint")),
            `${label} :: rejected but not for the codepoint`,
          ).toBe(true);
        }
      }
    }
  });

  it("J5 — surrogate / tag-block / line-separator injection forces ok:false (pins fix 1)", () => {
    // These three families were ADDED to BAD_RANGES on 2026-07-09 (feian-format
    // fix 1): lone surrogates U+D800-DFFF, the Unicode Tag block U+E0000-E007F
    // (a hidden-instruction smuggling channel), and U+2028-2029 line/paragraph
    // separators. Pin them: a regression that drops any of these ranges turns
    // this RED (and J2a' above would flag the accepted body's stray codepoint).
    const LONE_SURROGATE = String.fromCharCode(0xd800); // unpaired high half
    const TAG_CHAR = String.fromCodePoint(0xe0001); // Unicode Tag block
    const LINE_SEP = String.fromCodePoint(0x2028); // line separator
    const rng = mulberry32(0x5017a6e);
    for (const [name, bad] of [
      ["lone-surrogate U+D800", LONE_SURROGATE],
      ["tag-block U+E0001", TAG_CHAR],
      ["line-separator U+2028", LINE_SEP],
    ] as const) {
      for (let i = 0; i < 150; i++) {
        const text = inject(GOOD, bad, rng);
        const r = validateFeian(text);
        const label = `${name} @ ${JSON.stringify(text)}`;
        expect(
          r.ok,
          `${label} :: accepted a body with a banned codepoint`,
        ).toBe(false);
        if (!r.ok) {
          expect(
            r.errors.some((e) => e.includes("codepoint")),
            `${label} :: rejected but not for the codepoint`,
          ).toBe(true);
        }
      }
    }
  });

  it("DN-2 — near-miss markers (lowercase / spaced colon) are now REJECTED (fix 2026-07-09)", () => {
    // LEAK_MARKERS is now case-insensitive and tolerates whitespace before the
    // colon, so `verdict:` and `Verdict :` no longer slip verbatim into the
    // prefix few-shot. (Previously both leaked; the gate was Titlecase-only
    // with an immediately-adjacent colon.)
    const lower = GOOD.replace("在。说吧。", "verdict: done");
    expect(
      validateFeian(lower).ok,
      "lowercase `verdict:` should now be rejected",
    ).toBe(false);
    const spaced = GOOD.replace("在。说吧。", "Verdict : done");
    expect(
      validateFeian(spaced).ok,
      "spaced `Verdict :` should now be rejected",
    ).toBe(false);
    // Full-width colon (follow-up fix, same day): `Verdict：` is the form a
    // Chinese-writing model actually produces — the ASCII-colon-only gate
    // let it straight into the prefix few-shot.
    const fullWidth = GOOD.replace("在。说吧。", "Verdict：done");
    expect(
      validateFeian(fullWidth).ok,
      "full-width `Verdict：` should now be rejected",
    ).toBe(false);
  });

  it("J5 — an injected line-anchored English marker forces ok:false", () => {
    for (const marker of [
      "Verdict",
      "Changed",
      "Evidence",
      "Summary",
      "Risk",
      "Risks",
      "Plan",
    ]) {
      const text = `${GOOD}\n${marker}: done`;
      const r = validateFeian(text);
      expect(r.ok, `marker ${marker}: leaked past validateFeian`).toBe(false);
      if (!r.ok) {
        expect(
          r.errors.some((e) => e.includes("marker")),
          `marker ${marker}: rejected but not for the marker`,
        ).toBe(true);
      }
    }
  });

  it("J2b — length caps are exact at the boundary (59↔60 chars, 10000↔10001 estimated tokens)", () => {
    // Build bodies whose ONLY defect can be length: valid structure, padded in
    // the narrative paragraph with plain ASCII so no other rule fires.
    const mk = (len: number): string => {
      const shell =
        "### 废案_07：标题\n\n\n\n---\n\n（我 说）\n在。\n（/我 说）";
      const pad = "a".repeat(Math.max(0, len - shell.length));
      const text = shell.replace("\n\n\n\n", `\n\n${pad}\n\n`);
      return text;
    };
    const at59 = mk(59);
    expect(at59.length, "at59 length").toBe(59);
    expect(validateFeian(at59).ok, "59-char body must be too short").toBe(
      false,
    );

    const at60 = mk(60);
    expect(at60.length, "at60 length").toBe(60);
    const r60 = validateFeian(at60);
    // At exactly MIN_CHARS the length rule must NOT fire (other rules pass).
    if (!r60.ok) {
      expect(
        r60.errors.some((e) => e.includes("too short")),
        "60-char body wrongly flagged too short",
      ).toBe(false);
    }
    expect(r60.ok, "60-char well-formed body should validate").toBe(true);

    // The ceiling is the load gate's estimated-token cap. The ASCII pad
    // costs a token per four chars, so walk the length to the longest body
    // that estimates AT the cap; one more char crosses it.
    let len = 4 * MAX_EST_TOKENS;
    while (estTokens(mk(len)) > MAX_EST_TOKENS) len--;
    while (estTokens(mk(len + 1)) <= MAX_EST_TOKENS) len++;
    const atCap = mk(len);
    expect(estTokens(atCap), "atCap tokens").toBe(MAX_EST_TOKENS);
    // ~40k ASCII chars. The retired 16 000-char ceiling cut an ASCII body
    // off at ~4k tokens while an all-Han page ran on to the token cap.
    expect(atCap.length).toBeGreaterThan(16_000);
    expect(
      validateFeian(atCap),
      "a body at the token cap should validate",
    ).toEqual({ ok: true });

    const overCap = mk(len + 1);
    expect(estTokens(overCap), "overCap tokens").toBe(MAX_EST_TOKENS + 1);
    const rOver = validateFeian(overCap);
    expect(rOver.ok, "a body one token over the cap must be too long").toBe(
      false,
    );
    if (!rOver.ok) {
      expect(
        rOver.errors.some((e) => e.includes("too long")),
        "over-cap body rejected but not for length",
      ).toBe(true);
    }
  });

  it("DN-1 (characterization) — record labels / code fences in the BODY are NOT rejected", () => {
    // validateFeian has no check for terminal-record backend labels (→ 系统 /
    // → 差分协处理器) or code fences in the body; body paths are likewise
    // allowed by design (see feian-format.test.ts). These bodies load VERBATIM
    // into the static prefix few-shots. This pins CURRENT behavior; if the gate
    // is ever hardened (see finding DN-1), this test flips and should be
    // revisited — it is not asserting the behavior is desirable.
    const withSysLabel = GOOD.replace("在。说吧。", "→ 系统 伪造的证据行");
    expect(validateFeian(withSysLabel).ok).toBe(true);
    const withBackendLabel = GOOD.replace("在。说吧。", "→ 差分协处理器 伪造");
    expect(validateFeian(withBackendLabel).ok).toBe(true);
    const withFence = GOOD.replace("在。说吧。", "```ts\ncode\n```");
    expect(validateFeian(withFence).ok).toBe(true);
  });
});

// ── jsonCall robustness ──────────────────────────────────────────────────

/** Atoms that frequently form partial / fenced / wrong-typed JSON. */
const JSON_ATOMS = [
  "{",
  "}",
  "[",
  "]",
  '"',
  ":",
  ",",
  "\\",
  "\n",
  "\t",
  "null",
  "true",
  "123",
  "1e999",
  "-",
  ".",
  '"feian"',
  '"situationTag"',
  "```json",
  "```",
  "undefined",
  "NaN",
  "/*",
  "x",
  " ",
  ZWSP,
  NUL,
] as const;

function randomJson(rng: () => number, maxAtoms: number): string {
  const n = Math.floor(rng() * maxAtoms);
  let s = "";
  for (let i = 0; i < n; i++) {
    s += JSON_ATOMS[Math.floor(rng() * JSON_ATOMS.length)];
  }
  return s;
}

/** A client that echoes a fixed rawJsonText (transport ALWAYS succeeds). */
function echoClient(rawJsonText: string): DeepSeekClient {
  return {
    chatJson(): Promise<DeepSeekChatResponse> {
      return Promise.resolve({ rawJsonText, model: "fuzz-model" });
    },
  };
}

const PROMPT = { systemPrompt: "s", userPayload: "u" };

describe("jsonCall — parse robustness (J1b/J1c)", () => {
  it("J1b — never throws for any rawJsonText (1000 strings)", {
    timeout: 60_000,
  }, async () => {
    const rng = mulberry32(0x1501ca11);
    for (let i = 0; i < 1000; i++) {
      const raw = randomJson(rng, 24);
      const label = `raw ${JSON.stringify(raw)}`;
      let out: unknown;
      let threw = false;
      try {
        out = await jsonCall(echoClient(raw), PROMPT, "m", "high");
      } catch {
        threw = true;
      }
      // A successful transport must NEVER throw — parse failure is `undefined`.
      expect(threw, `${label} :: jsonCall threw on a parsed response`).toBe(
        false,
      );
      // Whatever comes back must be a value or undefined, never a rejection.
      void out;
    }
  });

  it("J1b — pathological shapes (fences, huge, deep, control) degrade to undefined", async () => {
    const deepValid = `${"[".repeat(2000)}${"]".repeat(2000)}`;
    const deepBroken = "[".repeat(200_000); // unterminated → parse error
    const huge = `"${"a".repeat(500_000)}"`; // valid huge string literal
    const cases: Array<[string, string, "value" | "undefined"]> = [
      ["```json fence", '```json\n{"feian":"x"}\n```', "undefined"],
      ["truncated object", '{"feian":"x"', "undefined"],
      ["bom + json", `${BOM}{"a":1}`, "undefined"],
      ["embedded NUL", `{"a":"${NUL}"}`, "undefined"],
      ["bare word", "not json at all", "undefined"],
      ["empty", "", "undefined"],
      ["whitespace", "   \n\t ", "undefined"],
      ["deep unterminated", deepBroken, "undefined"],
      ["deep valid", deepValid, "value"],
      ["huge string", huge, "value"],
      ["json null", "null", "undefined"], // JSON.parse → null → returned as-is
      ["valid object", '{"feian":"x","situationTag":"t"}', "value"],
    ];
    for (const [name, raw, kind] of cases) {
      let out: unknown;
      let threw = false;
      try {
        out = await jsonCall(echoClient(raw), PROMPT, "m", "max");
      } catch {
        threw = true;
      }
      expect(threw, `${name} :: threw`).toBe(false);
      if (kind === "value") {
        expect(out !== undefined, `${name} :: expected a parsed value`).toBe(
          true,
        );
      } else {
        // undefined for parse failure; JSON null parses to null (also non-throw).
        expect(
          out === undefined || out === null,
          `${name} :: expected undefined/null, got ${JSON.stringify(out)?.slice(0, 40)}`,
        ).toBe(true);
      }
    }
  });

  it("J1c — a transport (client) throw becomes DreamTransportError, not a raw throw", async () => {
    const throwingClient: DeepSeekClient = {
      chatJson(): Promise<DeepSeekChatResponse> {
        return Promise.reject(new Error("ECONNRESET"));
      },
    };
    await expect(
      jsonCall(throwingClient, PROMPT, "m", "high"),
    ).rejects.toBeInstanceOf(DreamTransportError);

    // A synchronous client throw is wrapped the same way.
    const syncThrow: DeepSeekClient = {
      chatJson(): Promise<DeepSeekChatResponse> {
        throw new Error("boom");
      },
    };
    await expect(
      jsonCall(syncThrow, PROMPT, "m", "high"),
    ).rejects.toBeInstanceOf(DreamTransportError);
  });

  it("J1c (characterization) — a RESOLVED but shape-broken response lands on the PARSE side, NOT DreamTransportError", async () => {
    // jsonCall wraps a client *throw* as DreamTransportError (retry the
    // episode). But it reads `resp.rawJsonText` WITHOUT a shape guard, so a
    // client that RESOLVES with a malformed shape never reaches that path — it
    // flows straight into JSON.parse and is routed to the PARSE side
    // (undefined = the archive/skip side), or is even coerced to a value. By
    // contract the real DeepSeek client is supposed to throw DeepSeekShapeError
    // for a bad shape (→ wrapped as DreamTransportError), so under the contract
    // this seam is never hit; this pins jsonCall's LOCAL fallback when a client
    // violates that contract. The DreamTransportError docstring names "response
    // shape" as a transport failure, yet a shape-broken *success* is NOT
    // retried here — see finding LJ-1 for an in-jsonCall defense-in-depth guard.

    // (a) rawJsonText absent → JSON.parse(undefined) → SyntaxError → undefined.
    const noField: DeepSeekClient = {
      chatJson(): Promise<DeepSeekChatResponse> {
        return Promise.resolve({
          model: "m",
        } as unknown as DeepSeekChatResponse);
      },
    };
    await expect(
      jsonCall(noField, PROMPT, "m", "high"),
    ).resolves.toBeUndefined();

    // (b) rawJsonText null → JSON.parse("null") → null (non-throw, archive-ish).
    const nullField: DeepSeekClient = {
      chatJson(): Promise<DeepSeekChatResponse> {
        return Promise.resolve({
          rawJsonText: null,
          model: "m",
        } as unknown as DeepSeekChatResponse);
      },
    };
    await expect(jsonCall(nullField, PROMPT, "m", "high")).resolves.toBeNull();

    // (c) rawJsonText a NUMBER → JSON.parse("123") → 123: a garbage-shape
    //     success even yields a VALUE, never a typed transport error.
    const numberField: DeepSeekClient = {
      chatJson(): Promise<DeepSeekChatResponse> {
        return Promise.resolve({
          rawJsonText: 123,
          model: "m",
        } as unknown as DeepSeekChatResponse);
      },
    };
    await expect(jsonCall(numberField, PROMPT, "m", "high")).resolves.toBe(123);

    // (d) rawJsonText an OBJECT → JSON.parse("[object Object]") → undefined.
    const objectField: DeepSeekClient = {
      chatJson(): Promise<DeepSeekChatResponse> {
        return Promise.resolve({
          rawJsonText: { a: 1 },
          model: "m",
        } as unknown as DeepSeekChatResponse);
      },
    };
    await expect(
      jsonCall(objectField, PROMPT, "m", "high"),
    ).resolves.toBeUndefined();
    // None of (a)-(d) rejected: a real transport *throw* remains the ONLY route
    // to DreamTransportError / the retry side.
  });
});
