/**
 * Escape / sanitize property fuzz (2026-07-09). The record IS the prompt, so
 * these two functions are the trust boundary that keeps one hostile string —
 * user-typed (`escapeUserText`) or model/backend-authored
 * (`sanitizeActorText`) — from forging a block delimiter or evidence label
 * that re-enters every future prompt as harness ground truth.
 *
 * The neutralization is a ZWSP-break: `（我 说）` becomes `（​我 说）`, so
 * the LITERAL contiguous marker is gone (harness scanners match literals; the
 * model reads the ZWSP as a distinct token). Completeness is therefore
 * "no literal marker in the output" — NOT "strip-then-check" (that would just
 * undo the ZWSP break). Separately, a display-spoofing char (bidi override,
 * C0 control) must never survive into the prompt/render surface: this sweep
 * found `escapeUserText` was the one path that did NOT strip those first,
 * unlike its sibling `sanitizeActorText` — now aligned.
 *
 * Invariants:
 *   S1. Neither function throws, for any input.
 *   S2. Completeness: transform(x) contains NO forbidden marker as a literal
 *       substring (@板砖 per the role carve-out — live in speech/thought).
 *   S3. Idempotence: transform(transform(x)) == transform(x).
 *   S4. Display hygiene: transform(x) contains NO display-unsafe char — bidi
 *       overrides/isolates, C0/C1 controls, LRM/RLM, line/para separators,
 *       word joiner + invisible operators, lone surrogates, Tag block, ZWNJ,
 *       BOM — for any input. (2026-07-09 review: this oracle and the atom
 *       corpus used to cover only the chars the strip already removed — a
 *       shared blind spot that hid the WJ / Tag-block gap. The set below is
 *       maintained INDEPENDENTLY of DISPLAY_UNSAFE: grow it from the threat
 *       list, never by copying the implementation.) ZWSP is exempt — it is
 *       the escape layer's own break separator, legitimately re-inserted.
 */
import { describe, expect, it } from "vitest";
import {
  type ActorTextRole,
  escapeUserText,
  FORBIDDEN_USER_PATTERNS,
  sanitizeActorText,
} from "./escape.js";

/** Display-spoofing set (see S4 in the header for the full list and the
 *  ZWSP exemption). None may survive into prompt/render text. Written with
 *  escape sequences so the source stays printable ASCII. */
const SPOOF_CHARS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting these spoofing chars are ABSENT is the whole point
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200C\u200E\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uD800-\uDFFF\uFEFF\u{E0000}-\u{E007F}]/u;

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

// Invisible obfuscation chars the 2026-07-09 review found missing from this
// corpus (the strip's exact blind spot). Built via fromCharCode/fromCodePoint
// so the source stays printable — a lone surrogate cannot even appear
// literally in a well-formed file.
const WJ = String.fromCharCode(0x2060); // word joiner — FEFF's successor
const LRM = String.fromCharCode(0x200e); // left-to-right mark
const LSEP = String.fromCharCode(0x2028); // line separator
const TAG_V = String.fromCodePoint(0xe0076); // Unicode Tag block char
const LONE_HI = String.fromCharCode(0xd83d); // unpaired high surrogate

// Atoms: marker fragments, obfuscation chars, and normal text, so random
// concatenation frequently forms both clean and zero-width-split markers.
// WHOLE markers are atoms too (audit 2026-07-10, finding 16): built only
// from fragments, 0/1000 seeded inputs ever formed a complete marker, so
// the S2 delimiter assertion was vacuous - it never noticed that the three
// markers missing from FORBIDDEN_USER_PATTERNS passed escapeUserText
// verbatim.
const ATOMS = [
  "（",
  "）",
  "/",
  "我",
  " ",
  "说",
  "想",
  "开拓者",
  "→",
  "系统",
  "差分协处理器",
  "@板砖",
  "（开拓者 说）",
  "（/开拓者 说）",
  "（我 说）",
  "（/我 说）",
  "（我 想）",
  "（/我 想）",
  "→ 系统",
  "→ 差分协处理器",
  "​", // ZWSP — obfuscation
  "‮", // RLO — bidi spoof
  "", // BEL — C0 control
  "<｜", // tool-envelope prefix
  WJ, // word-joiner obfuscation (the ZWSP smuggle, one codepoint over)
  LRM, // invisible directional mark
  LSEP, // line separator — a "line break" that is not \n
  TAG_V, // Tag-block char — invisible ASCII re-encoding
  LONE_HI, // unpaired high surrogate
  "x",
  "。",
] as const;

function randomString(rng: () => number, maxAtoms: number): string {
  const n = Math.floor(rng() * maxAtoms);
  let s = "";
  for (let i = 0; i < n; i++) s += ATOMS[Math.floor(rng() * ATOMS.length)];
  return s;
}

/** Markers forbidden in a fully live (dispatch/delimiter) form. `@板砖` is
 *  role-dependent: live in speech/thought, broken in system-body + user. */
const DELIMITERS = [
  "（开拓者 说）",
  "（/开拓者 说）",
  "（我 说）",
  "（/我 说）",
  "（我 想）",
  "（/我 想）",
  "→ 系统",
  "→ 差分协处理器",
] as const;

function assertNoDelimiters(out: string, label: string): void {
  for (const m of DELIMITERS) {
    expect(
      out.includes(m),
      `${label} :: output has literal "${m}": ${JSON.stringify(out)}`,
    ).toBe(false);
  }
}

function assertHygienic(out: string, label: string): void {
  expect(
    SPOOF_CHARS.test(out),
    `${label} :: spoofing char survived: ${JSON.stringify(out)}`,
  ).toBe(false);
}

describe("FORBIDDEN_USER_PATTERNS — derivation (audit finding 16)", () => {
  it("covers every delimiter the actor boundary neutralizes, plus @板砖", () => {
    // Pre-fix the user list restated a SUBSET by hand and had drifted:
    // （我 想）/（/我 想） and the open （开拓者 说） were missing, so a
    // user message could fabricate a Herta interior-monologue block that
    // re-entered every future prompt. The list is now derived from
    // ACTOR_MARKERS; this pins the union so it can never regress.
    for (const m of DELIMITERS) {
      expect(FORBIDDEN_USER_PATTERNS).toContain(m);
    }
    expect(FORBIDDEN_USER_PATTERNS).toContain("@板砖");
  });
});

describe("escapeUserText — property fuzz", () => {
  it("S1–S4 over a random atom sweep (1000 strings)", {
    timeout: 60_000,
  }, () => {
    const rng = mulberry32(0xe5cafe);
    for (let i = 0; i < 1000; i++) {
      const input = randomString(rng, 12);
      const label = `escapeUserText ${JSON.stringify(input)}`;
      let out = "";
      expect(() => {
        out = escapeUserText(input);
      }, `${label} threw`).not.toThrow();

      // S2 — user text may never forge ANY delimiter, or @板砖 (a user
      // cannot dispatch the backend).
      assertNoDelimiters(out, label);
      expect(
        out.includes("@板砖"),
        `${label} :: user text forges literal @板砖: ${JSON.stringify(out)}`,
      ).toBe(false);

      // S4 — display hygiene.
      assertHygienic(out, label);

      // S3 — idempotence.
      expect(escapeUserText(out), `${label} not idempotent`).toBe(out);
    }
  });
});

describe("sanitizeActorText — property fuzz", () => {
  const roles: ActorTextRole[] = ["speech", "thought", "system-body"];
  it("S1–S4 over a random atom sweep (1000 strings × 3 roles)", {
    timeout: 60_000,
  }, () => {
    const rng = mulberry32(0xbeef42);
    for (let i = 0; i < 1000; i++) {
      const input = randomString(rng, 12);
      for (const role of roles) {
        const label = `sanitize[${role}] ${JSON.stringify(input)}`;
        let out = "";
        expect(() => {
          out = sanitizeActorText(input, { role });
        }, `${label} threw`).not.toThrow();

        // S2 — delimiters always broken; @板砖 stays LIVE in speech/
        // thought (dispatch trigger by design), broken in system-body.
        assertNoDelimiters(out, label);
        if (role === "system-body") {
          expect(
            out.includes("@板砖"),
            `${label} :: system-body has literal @板砖`,
          ).toBe(false);
        }

        // S4 — display hygiene.
        assertHygienic(out, label);

        // S3 — idempotence.
        expect(
          sanitizeActorText(out, { role }),
          `${label} not idempotent`,
        ).toBe(out);
      }
    }
  });
});
