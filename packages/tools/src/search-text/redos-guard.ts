/**
 * Conservative nested-quantifier detector (audit 2026-07-13 T2.3). The
 * `(a+)+`-family turns JS's backtracking RegExp engine exponential, and a
 * single `.test()` on a long line then blocks the event loop for minutes —
 * past every abort signal, since nothing in JS can interrupt a running
 * match. search_text's pattern is model-supplied, so a prompt-injected task
 * could hang the whole agent process with one call.
 *
 * The check walks the pattern source and rejects an UNBOUNDED quantifier
 * (`*`, `+`, `{n,}`, or `{n,m}` with a large m) applied to a group that
 * itself contains an unbounded quantifier at any depth. `?` and small
 * bounded repetitions never trip it. This is a heuristic, not a proof —
 * ambiguous-alternation shapes like `(a|a)*` pass it, which is why the
 * scanner also keeps a wall-clock budget as the backstop.
 */

/** `{n,m}` with m at/over this behaves like an unbounded quantifier for
 *  backtracking purposes (mirrors the safe-regex library's repetition cap). */
const UNBOUNDED_REPETITION = 25;

export function hasCatastrophicQuantifier(source: string): boolean {
  /** Per open group: did the ENCLOSING level already contain an unbounded
   *  quantifier before this group opened? */
  const stack: boolean[] = [];
  /** Does the current group level (including closed inner groups) contain an
   *  unbounded quantifier? */
  let containsUnbounded = false;
  /** Set when the previous token closed a group: whether that group's
   *  contents held an unbounded quantifier. A quantifier token reads this to
   *  detect the nested shape; every other token clears it. */
  let closedGroupHadUnbounded: boolean | null = null;
  let inClass = false;

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++; // the escaped char is a literal — skip it
      closedGroupHadUnbounded = null;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    switch (c) {
      case "[":
        inClass = true;
        closedGroupHadUnbounded = null;
        break;
      case "(":
        stack.push(containsUnbounded);
        containsUnbounded = false;
        closedGroupHadUnbounded = null;
        break;
      case ")": {
        const inner: boolean = containsUnbounded;
        containsUnbounded = (stack.pop() ?? false) || inner;
        closedGroupHadUnbounded = inner;
        break;
      }
      case "*":
      case "+":
      case "{": {
        let unbounded = c !== "{";
        if (c === "{") {
          const m = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(i));
          if (m === null) {
            // Not a quantifier — a literal '{'.
            closedGroupHadUnbounded = null;
            break;
          }
          const upper = m[2];
          unbounded =
            upper !== undefined &&
            (upper === "" || Number(upper) >= UNBOUNDED_REPETITION);
          i += m[0].length - 1;
        }
        if (unbounded) {
          if (closedGroupHadUnbounded === true) return true;
          containsUnbounded = true;
        }
        closedGroupHadUnbounded = null;
        break;
      }
      default:
        closedGroupHadUnbounded = null;
        break;
    }
  }
  return false;
}
