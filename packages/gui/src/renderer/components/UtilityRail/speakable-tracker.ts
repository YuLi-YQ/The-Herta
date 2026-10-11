/**
 * Append-aware companion to `scanSpeakable` (perf 2026-08-25). The speech
 * envelope re-scanned the FULL text on every growth event — O(reply) per
 * reveal frame. The scan is line-based with fence parity, so for an
 * append-only input only two things can change: newly COMPLETED lines
 * (classified once, then frozen — a completed line's fence state depends
 * only on the lines before it), and the current PARTIAL line, whose
 * classification can flip as it grows ("``" reads as prose until the
 * third backtick arrives, " " becomes a table row when "|" lands) — so it
 * is re-classified from scratch on every push, O(current line).
 *
 * `grown` is the change in total speakable count since the last push —
 * negative on partial-line reclassification or a reset, exactly like
 * diffing two batch scans; callers treat only > 0 as kicks (the hook
 * always did). A non-append input resets and re-derives, so the running
 * total always equals `scanSpeakable(text).count` and `last` equals
 * `scanSpeakable(text).last` (the equivalence test replays prefixes).
 */
export interface SpeakableGrowthStep {
  /** Speakable code points gained since the previous push (may be ≤ 0). */
  readonly grown: number;
  /** Last speakable character of the current text, or null. */
  readonly last: string | null;
  /** Chars examined this push (completed lines + current-line rescan). */
  readonly scanned: number;
}

export interface SpeakableTracker {
  push(text: string): SpeakableGrowthStep;
}

/** Last code point of `line.trimEnd()`, or null for a blank/ws-only line. */
function lastSpeakableChar(line: string): string | null {
  const tail = [...line.trimEnd()];
  return tail.length > 0 ? (tail[tail.length - 1] ?? null) : null;
}

export function createSpeakableTracker(): SpeakableTracker {
  let prev = "";
  let prevTotal = 0;
  let doneCount = 0;
  let doneLast: string | null = null;
  let fence = false;
  let lineStart = 0;

  // NOTE: `prevTotal` deliberately survives a reset — `grown` must stay a
  // pure diff of consecutive batch totals (a replaced turn diffs negative
  // and kicks nothing, exactly like the old full-rescan hook), while the
  // line-scan state re-derives for the new text.
  const reset = (): void => {
    prev = "";
    doneCount = 0;
    doneLast = null;
    fence = false;
    lineStart = 0;
  };

  return {
    push(text: string): SpeakableGrowthStep {
      if (!text.startsWith(prev)) reset();
      let scanned = 0;

      // Consume newly completed lines. New newlines can only be in the
      // appended region, but each completed line spans from `lineStart`.
      let searchFrom = Math.max(lineStart, prev.length);
      let nl = text.indexOf("\n", searchFrom);
      while (nl !== -1) {
        const line = text.slice(lineStart, nl);
        scanned += line.length + 1;
        const trimmed = line.trimStart();
        if (trimmed.startsWith("```")) {
          fence = !fence; // the fence line itself is not spoken
        } else if (!fence && !trimmed.startsWith("|")) {
          doneCount += [...line].length;
          doneLast = lastSpeakableChar(line) ?? doneLast;
        }
        lineStart = nl + 1;
        searchFrom = lineStart;
        nl = text.indexOf("\n", searchFrom);
      }

      // Re-classify the current partial line from scratch.
      const partial = text.slice(lineStart);
      scanned += partial.length;
      let liveCount = 0;
      let liveLast: string | null = null;
      const trimmed = partial.trimStart();
      if (!trimmed.startsWith("```") && !fence && !trimmed.startsWith("|")) {
        liveCount = [...partial].length;
        liveLast = lastSpeakableChar(partial);
      }

      const total = doneCount + liveCount;
      const grown = total - prevTotal;
      prevTotal = total;
      prev = text;
      return { grown, last: liveLast ?? doneLast, scanned };
    },
  };
}
