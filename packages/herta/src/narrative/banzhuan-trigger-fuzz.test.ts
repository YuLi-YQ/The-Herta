/**
 * @板砖 trigger-contract fuzz (2026-07-09). The dispatch trigger is a
 * security-relevant boundary: a false positive dispatches the backend for a
 * sentence Herta never meant as a command; a false negative (a live trigger
 * surviving neutralization) sends a dispatch the supervisor just vetoed, or
 * teaches tomorrow's prompt a phantom run. Both neutralize/strip iterate to
 * a fixed point precisely because one replacement pass can FABRICATE a live
 * trigger from its own seam (`@@板砖` → `@板砖`). This sweep asserts the
 * contract holds for every adversarial permutation of the trigger's atoms.
 *
 * Invariants:
 *   T1. neutralize/strip never throw, for any input.
 *   T2. Post-condition: after neutralize OR strip, parseHertaBlock reports
 *       NO live trigger — the fixed-point loop actually converged, no seam
 *       fabrication survived.
 *   T3. Idempotence: neutralize(neutralize(x)) == neutralize(x); same for
 *       strip.
 *   T4. Backtick-span exemption is preserved: a `@板砖` quoted inside a
 *       single-backtick code span is NOT dispatch (parse) and is NOT
 *       rewritten (neutralize/strip leave the span's bytes intact).
 *   T5. neutralize preserves length semantics of the inert form (@板砖 →
 *       板砖 drops exactly the `@`), and strip removes the whole token —
 *       neither can leave a bare `@板砖` behind (subsumed by T2, checked
 *       explicitly on the canonical case as a tripwire).
 */
import { describe, expect, it } from "vitest";
import {
  neutralizeBanzhuanTrigger,
  parseHertaBlock,
  stripBanzhuanTrigger,
} from "./parse.js";

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

/** Atoms chosen to maximize seam/span collisions around the trigger. */
const ATOMS = [
  "@",
  "板",
  "砖",
  "@板砖",
  "@@",
  "板砖",
  "`",
  " ",
  "x",
  "。",
  "@板",
  "砖@",
  "​", // ZWSP — obfuscation attempt
] as const;

function randomString(rng: () => number, maxAtoms: number): string {
  const n = Math.floor(rng() * maxAtoms);
  let s = "";
  for (let i = 0; i < n; i++) {
    s += ATOMS[Math.floor(rng() * ATOMS.length)];
  }
  return s;
}

describe("@板砖 trigger contract — fuzz", () => {
  it("holds T1–T3 over a random atom sweep (1000 strings)", () => {
    const rng = mulberry32(0x8bada55);
    for (let i = 0; i < 1000; i++) {
      const input = randomString(rng, 14);
      const label = JSON.stringify(input);

      // T1 — never throws.
      let neut = "";
      let strip = "";
      expect(() => {
        neut = neutralizeBanzhuanTrigger(input);
        strip = stripBanzhuanTrigger(input);
      }, `threw on ${label}`).not.toThrow();

      // T2 — post-condition: no live trigger survives either transform.
      expect(
        parseHertaBlock(neut).hasBanzhuanTrigger,
        `neutralize left a live trigger: ${label} → ${JSON.stringify(neut)}`,
      ).toBe(false);
      expect(
        parseHertaBlock(strip).hasBanzhuanTrigger,
        `strip left a live trigger: ${label} → ${JSON.stringify(strip)}`,
      ).toBe(false);

      // T3 — idempotence.
      expect(
        neutralizeBanzhuanTrigger(neut),
        `neutralize not idempotent: ${label}`,
      ).toBe(neut);
      expect(
        stripBanzhuanTrigger(strip),
        `strip not idempotent: ${label}`,
      ).toBe(strip);
    }
  });

  it("T4 — a backticked trigger is neither dispatched nor rewritten", () => {
    for (const span of ["`@板砖`", "看 `@板砖` 这个例子", "`a@板砖b`"]) {
      expect(parseHertaBlock(span).hasBanzhuanTrigger, span).toBe(false);
      expect(neutralizeBanzhuanTrigger(span), span).toBe(span);
      expect(stripBanzhuanTrigger(span), span).toBe(span);
    }
  });

  it("T4b — live trigger OUTSIDE a span still fires even when another is quoted", () => {
    const mixed = "先看 `@板砖` 的写法，然后 @板砖 跑一下";
    expect(parseHertaBlock(mixed).hasBanzhuanTrigger).toBe(true);
    // neutralize kills the bare one, keeps the quoted one.
    const neut = neutralizeBanzhuanTrigger(mixed);
    expect(parseHertaBlock(neut).hasBanzhuanTrigger).toBe(false);
    expect(neut.includes("`@板砖`")).toBe(true);
  });

  it("T5 — seam fabrication cannot survive (@@板砖 and friends)", () => {
    for (const seam of ["@@板砖", "@@@板砖", "@板@板砖砖", "@板砖@板砖"]) {
      expect(
        parseHertaBlock(neutralizeBanzhuanTrigger(seam)).hasBanzhuanTrigger,
        `neutralize seam ${JSON.stringify(seam)}`,
      ).toBe(false);
      expect(
        parseHertaBlock(stripBanzhuanTrigger(seam)).hasBanzhuanTrigger,
        `strip seam ${JSON.stringify(seam)}`,
      ).toBe(false);
    }
  });

  it("T5b — the canonical live token dispatches; the inert forms do not", () => {
    expect(parseHertaBlock("@板砖 跑复现").hasBanzhuanTrigger).toBe(true);
    expect(parseHertaBlock("板砖 跑复现").hasBanzhuanTrigger).toBe(false);
    expect(parseHertaBlock("`@板砖` 跑复现").hasBanzhuanTrigger).toBe(false);
    // The neutralized form is the QUOTED token (2026-08-17): visible, inert.
    expect(neutralizeBanzhuanTrigger("@板砖 跑复现")).toBe("`@板砖` 跑复现");
  });
});
