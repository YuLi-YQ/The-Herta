/**
 * Deterministic "is this actually dialogue?" guard for committed speech.
 *
 * The supervisor is an LLM judge, so every path that skips it — the
 * veto respeak (§6.4, "commits the ladder's result unconditionally
 * without a second supervisor pass"), the same-state empty-speech
 * retry, a supervisor deadline/provider error fail-softing to OK, and
 * an install with `config.supervisor.enabled = false` — commits
 * whatever the model produced. A degenerate completion that emits the
 * TEMPLATE SLOT instead of filling it (`{需要说的话}`) therefore reaches
 * the user verbatim. That was a real report, 2026-08-12.
 *
 * This needs no model to recognise, so it runs at the commit boundary
 * and covers all four paths at zero latency and zero tokens.
 *
 * DELIBERATELY NARROW. It fires only when the WHOLE line is a slot
 * token, because the cost of a false positive is suppressing real
 * speech. Specifically it must NOT catch:
 *   - "把 `{}` 改成 `[]`" — she talks about code; braces INSIDE a
 *     sentence are ordinary content.
 *   - "……" — the 被烦版 silence reply is BY DESIGN (mood lab
 *     2026-07-17); a punctuation-only line is not this bug.
 *   - "（他没听懂。）" — a parenthetical-only line is narration, which
 *     is the supervisor's rule, not a template slot. Different defect,
 *     different owner.
 */

/** Zero-width and bidi characters that could otherwise smuggle a slot
 *  past the whole-string match. Same class the dream user-line gate
 *  normalises away. */
// Alternation rather than a character class: a class containing ZWJ can
// match a joined character sequence (biome noMisleadingCharacterClass).
const INVISIBLE_RE = /(?:\s|​|‌|‍|⁠|﻿)+/g;

/** Trailing sentence punctuation to ignore — a model that emits
 *  `{需要说的话}。` produced a slot, not a sentence. */
const TRAILING_PUNCT_RE = /[。．.、，,；;：:！!？?~～\-—]+$/;

/**
 * Whole-string template-slot shapes. Each requires that the delimiters
 * do not recur inside, so a long line that merely BEGINS with `{` and
 * ENDS with `}` is not swept up.
 */
const SLOT_RES: readonly RegExp[] = [
  /^\$?\{{1,2}[^{}]*\}{1,2}$/, // {x} {{x}} ${x}
  /^｛{1,2}[^｛｝]*｝{1,2}$/, // fullwidth braces
  /^<{1,2}[^<>]*>{1,2}$/, // <x> <<x>>
  /^\[{1,2}[^[\]]*\]{1,2}$/, // [x] [[x]]
  /^［{1,2}[^［］]*］{1,2}$/, // fullwidth brackets
  /^%[^%\s]+%$/, // %x%
];

/**
 * True when `text` is nothing but a template slot — the model emitting
 * the placeholder rather than filling it.
 *
 * An EMPTY slot (`{}`, `<>`) counts: it is equally not dialogue, and
 * treating it as usable would let `{}` through the same hole.
 */
export function isPlaceholderOnly(text: string): boolean {
  const bare = text.replace(INVISIBLE_RE, "").replace(TRAILING_PUNCT_RE, "");
  if (bare.length === 0) return false; // empty is the caller's other branch
  return SLOT_RES.some((re) => re.test(bare));
}

/**
 * The commit-boundary predicate: speech that must not reach the user.
 *
 * Folds emptiness and slot-only into ONE test so the existing recovery
 * machinery covers both. A slot-only completion is the same class of
 * failure as an empty one — the model produced no content — so it gets
 * the same treatment: the rising-temperature retry ladder, and if that
 * exhausts, the turn ends quietly rather than committing the garbage.
 */
export function isUnusableBlock(text: string): boolean {
  return text.trim().length === 0 || isPlaceholderOnly(text);
}

/**
 * Remove echoed HINT SCAFFOLDING from a generation (live lab, 2026-08-12).
 *
 * Every actor hint is wrapped in `〔…〕` and appended to the prompt directly
 * before the open tag, so the model's last few hundred tokens of context are
 * a bracketed instruction. It sometimes continues in that format — writing
 * its own `〔…〕` aside before (or instead of) the real block. Measured at
 * 2 of 96 real generations, both on the longest, most instructional retry
 * variants; never on short first-pass hints.
 *
 * Two observed shapes, and they want opposite repairs:
 *
 *   `〔instruction〕\n真正的台词`  — the model restated the hint, then
 *       answered. The answer is what follows; drop the bracket line.
 *   `〔完整的一段思考〕`          — the content is GOOD, only the wrapper is
 *       wrong. Unwrap it rather than discard a usable block.
 *
 * Safe because `〔…〕` is reserved: it appears in hint files and nowhere in
 * her corpus (Bio, Guide, EnvSet, openings, 废案 seeds all verified clean),
 * so a leading, trailing or whole-wrap bracket is never her voice. A bracket
 * appearing mid-sentence is left alone — only a pair at an EDGE is
 * scaffolding.
 *
 * A third shape, trailing (large-document lab, 2026-08-23, twice in one
 * session after a 13-minute backend turn had filled the record):
 *
 *   `真正的台词 〔到这里，只准停，…不得写任何命令。〕` — the answer, then a
 *       bracketed directive the model wrote for its own NEXT step, in the
 *       hint's register. Both reached the user's screen verbatim. Drop the
 *       trailing pair; the answer is what precedes it.
 *
 *   The trailing case is narrower than the leading one ON PURPOSE. The
 *   first cut stripped any trailing pair, and the same day a speech that
 *   ended in a list of quoted lines committed as `…没拿行号顶页码：` — the
 *   list was gone. `〔…〕` is reserved in the HARNESS's prose, but Chinese
 *   typography uses it for citation marks (`〔1〕`, `〔行 7902〕`), which is
 *   exactly what a speech citing a document ends with. So a trailing pair
 *   is stripped only when its content reads as a directive (只准/不得/
 *   不写/无命令/… — the register of both observed leaks); a citation-shaped
 *   pair stays. A leading pair keeps the original rule: content never
 *   starts with a bare citation.
 *
 * A fourth shape, UNCLOSED (voice register lab, 2026-09-23: 6 of ~900
 * blocks across 9 runs, every one at the end of a thought):
 *
 *   `红了。三处全在一个坑里，正好。\n〔下面是嘴上说的话，必须以` — the
 *       model began writing the NEXT phase's hint, and the open-tag stop
 *       sequence quoted inside that hint cut it before its `〕`. It reached
 *       the record verbatim, because the rules above only see closed pairs.
 *       A citation always closes, so an unclosed bracket at the end is never
 *       her voice: drop it. A block that is nothing BUT the fragment becomes
 *       empty and takes the empty ladder — it never commits hint prose.
 *
 * Runs BEFORE the usability check, which is what makes the nested case work:
 * `〔{需要说的话}〕` unwraps to `{需要说的话}`, which `isPlaceholderOnly`
 * then catches, so it takes the slot ladder instead of committing. Stripping
 * never rescues junk — it just stops the wrapper from hiding it.
 */
/** The register of a self-directive: prohibitions and stage directions the
 *  hints are written in. A citation (`〔1〕`, `〔行 7902〕`, `〔第101篇〕`)
 *  carries none of these. Both languages, since the EN hints echo too. */
const TRAILING_DIRECTIVE =
  /只准|不得|不许|不要|不写|禁止|无命令|到这里|这句之后|接下来|只说|停[。，]|\b(?:stop|do not|don't|only say|next:)\b/i;

export function stripHintScaffolding(text: string): string {
  // Fast path: the overwhelming majority of generations carry no bracket at
  // all and must come back byte-identical.
  if (!text.includes("〔")) return text;
  let out = text;
  // Leading echoed hint lines that PRECEDE real content. Bounded — a model
  // stuck emitting brackets forever is the ladder's problem, not ours.
  for (let i = 0; i < 3; i += 1) {
    const m = /^\s*〔[^〔〕]*〕\s*/.exec(out);
    if (m === null) break;
    const rest = out.slice(m[0].length);
    if (rest.trim().length === 0) break; // whole-wrap — handled just below
    out = rest;
  }
  // An unclosed trailing bracket: the start of a hint the stop sequence cut.
  const cut = /\s*〔[^〔〕]*$/.exec(out);
  if (cut !== null) out = out.slice(0, cut.index);
  // Trailing self-directives that FOLLOW real content, same bound — and
  // only when the bracket's content is directive-shaped (see above).
  for (let i = 0; i < 3; i += 1) {
    const m = /\s*〔([^〔〕]*)〕\s*$/.exec(out);
    if (m === null || !TRAILING_DIRECTIVE.test(m[1] ?? "")) break;
    const rest = out.slice(0, m.index);
    if (rest.trim().length === 0) break; // whole-wrap — handled just below
    out = rest;
  }
  const whole = /^\s*〔([^〔〕]*)〕\s*$/.exec(out);
  return whole !== null ? (whole[1] ?? "").trim() : out.trim();
}

/**
 * WHY an attempt was rejected — which retry ladder should correct it.
 * Applies to BOTH surfaces: speech and thought fail the same two ways.
 *
 * The two failures need different accusations. The empty ladder says
 * "闭合得太快 / 不能空白", which is simply FALSE when the model emitted a
 * placeholder: it did not close early, it wrote something. Telling it the
 * wrong thing means the retry recovers by re-rolling rather than by
 * correcting, which is the same mistake the ADR 0036 refine loop avoids by
 * feeding each gate's actual finding back into the prompt.
 */
export type RetryCause = "empty" | "slot";

/** The cause, or `undefined` when the text is usable and no retry is due. */
export function retryCause(text: string): RetryCause | undefined {
  if (text.trim().length === 0) return "empty";
  if (isPlaceholderOnly(text)) return "slot";
  return undefined;
}
