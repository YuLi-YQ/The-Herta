/**
 * CJK-aware prompt-token estimator. A Han ideograph counts 0.65 token,
 * every other non-ASCII codepoint ~1 token, ASCII runs ÷4 (rounded up per
 * run). Promoted from the actor's recap subsystem (session-recap.ts, L4
 * non-ASCII floor fix) to core for ADR 0025 slice 2 so the backend's
 * context budget uses the same arithmetic as the actor's compaction
 * thresholds.
 *
 * History of the calibration (from the recap fix): originally only the
 * BMP CJK ranges got the 1-token treatment, and Hangul/Cyrillic/Arabic/
 * emoji/CJK-Ext-B fell into the ÷4 ASCII run — an up-to-4× UNDERcount,
 * the dangerous direction for a threshold that decides when trimming
 * must engage (the real prompt could blow past the model window while
 * the estimate still read under high-water). Charging every non-ASCII
 * codepoint 1 is slightly conservative for scripts DeepSeek tokenizes
 * multi-char (Latin-adjacent diacritics) and slightly generous for
 * scripts at >1 token/char (some emoji, Ext-B) — but the error is
 * bounded and mostly in the safe direction.
 *
 * The Han weight (2026-09-21, ADR 0068 §9) — MEASURED against the API's own
 * `prompt_tokens`, identical on deepseek-flash and deepseek-v4-pro. At 1
 * token per ideograph the estimate ran 1.38× the real count over Herta's
 * Chinese prompt files (1.17–1.59) and 1.35× on a session-shaped record, so
 * a budget that said 200K engaged near 130–150K real tokens in a zh session
 * — the recap compacted Herta's memory at two thirds of the threshold the
 * config states. Pure Han text costs 0.58 token per character; with the
 * rest of this function as it is, 0.65 lands the estimate at 1.04× (0.93–
 * 1.16) and 1.04× on the session shape — still a shade conservative on
 * average, the same side English prose errs on (1.12×; TypeScript source
 * 0.99×). Only the BMP Han blocks get it: CJK punctuation and fullwidth
 * forms cost ~1 in running text (measured, fit 1.07) and stay at 1, as do
 * kana, Hangul, Ext-B and every script nobody measured. The budgets have
 * a 5× margin to the 1M window; the point of the weight is that a
 * threshold means what it says, not overflow safety.
 *
 * An index loop over UTF-16 code units (2026-09-03), not `for…of`: the
 * string iterator allocated a one-character string per code point, and
 * the backend budget runs this over its whole transcript every tool
 * call. A surrogate PAIR is one code point and counts once, exactly as
 * the iterator form did.
 */
export function estimatePromptTokens(text: string): number {
  let tokens = 0;
  let asciiRun = 0;
  let han = 0;
  const n = text.length;
  for (let i = 0; i < n; i += 1) {
    const cu = text.charCodeAt(i);
    if (cu > 0x7f) {
      tokens += Math.ceil(asciiRun / 4);
      asciiRun = 0;
      if (isHanUnit(cu)) {
        han += 1;
        continue;
      }
      tokens += 1;
      // A high surrogate's low half is the same code point — skip it.
      if (cu >= 0xd800 && cu <= 0xdbff && i + 1 < n) {
        const lo = text.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) i += 1;
      }
    } else {
      asciiRun += 1;
    }
  }
  // Integer arithmetic (13/20 = 0.65): no float drift between platforms,
  // and one rounding per text, not per character.
  return tokens + Math.ceil(asciiRun / 4) + Math.ceil((han * 13) / 20);
}

/** The BMP Han blocks: Unified Ideographs, Extension A, Compatibility
 *  Ideographs. All single UTF-16 units, so the code unit IS the code point. */
function isHanUnit(cu: number): boolean {
  return (
    (cu >= 0x4e00 && cu <= 0x9fff) ||
    (cu >= 0x3400 && cu <= 0x4dbf) ||
    (cu >= 0xf900 && cu <= 0xfaff)
  );
}
