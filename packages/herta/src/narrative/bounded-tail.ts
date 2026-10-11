export interface BoundedTailOpts {
  /** Max lines to keep from the tail. Default 15. */
  readonly maxLines?: number;
  /** Max characters of the result. Default 800. */
  readonly maxChars?: number;
  /** Full-output log path, included in the truncation marker. */
  readonly logPath?: string;
  /** Set when the SOURCE was already truncated upstream (RunCommandData
   *  stdoutTruncated/stderrTruncated), so we mark truncated even if our
   *  own caps weren't hit. */
  readonly sourceTruncated?: boolean;
}

export interface BoundedTailResult {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Build a bounded TAIL excerpt of a command's output for Herta's prompt
 * (SystemBlock.evidenceDetail). Prefers stdout; falls back to a labeled
 * stderr tail when stdout is empty; if both present, stdout tail then a
 * short labeled stderr tail. Each stream is capped INDEPENDENTLY before the
 * [stderr] label is composed in, so a long stdout can never slice the label
 * away. Takes the LAST lines (a script's result/output is at the end). Caps
 * by lines AND chars, whichever hits first. Appends a
 * `…(truncated, full log: <logPath>)` marker when clipped or when the
 * source was already truncated. Never throws; empty input → empty result.
 *
 * See docs/superpowers/specs/2026-05-31-backend-outcome-surfacing-design.md.
 */
export function boundedTail(
  stdout: string,
  stderr: string,
  opts: BoundedTailOpts,
): BoundedTailResult {
  const maxLines = opts.maxLines ?? 15;
  const maxChars = opts.maxChars ?? 800;

  const so = stdout.trimEnd();
  const se = stderr.trimEnd();

  // Early empty return.
  if (so.length === 0 && se.length === 0) {
    return { text: "", truncated: false };
  }

  let truncated = opts.sourceTruncated === true;

  let body: string;
  if (so.length > 0 && se.length > 0) {
    // Both present: cap each stream INDEPENDENTLY, then compose with the
    // [stderr] label added AFTER capping — so the label can never be sliced
    // away by a long stdout (the bug this guards against). stdout keeps the
    // main budget; stderr gets a short fixed tail (last 5 lines / 300 chars).
    const stdoutTail = capStream(so, maxLines, maxChars);
    const stderrTail = capStream(se, 5, 300);
    if (stdoutTail.clipped || stderrTail.clipped) {
      truncated = true;
    }
    body = `${stdoutTail.text}\n[stderr]\n${stderrTail.text}`;
  } else if (so.length > 0) {
    // stdout only: full budget.
    const stdoutTail = capStream(so, maxLines, maxChars);
    if (stdoutTail.clipped) {
      truncated = true;
    }
    body = stdoutTail.text;
  } else {
    // stderr only: full budget, still labeled.
    const stderrTail = capStream(se, maxLines, maxChars);
    if (stderrTail.clipped) {
      truncated = true;
    }
    body = `[stderr]\n${stderrTail.text}`;
  }

  // Soft cap note: the final length is `maxChars + marker.length` (the marker
  // is intentionally outside the char budget); the test's slack accounts for
  // realistic log-path lengths.
  const marker = truncated
    ? `\n…(truncated${opts.logPath ? `, full log: ${opts.logPath}` : ""})`
    : "";
  return { text: body + marker, truncated };
}

interface CappedStream {
  readonly text: string;
  readonly clipped: boolean;
}

/** Cap a single string to (maxLines, maxChars) tail and report if clipped. */
function capStream(
  text: string,
  maxLines: number,
  maxChars: number,
): CappedStream {
  let clipped = false;

  // Line cap (tail).
  const lines = text.split("\n");
  let out = text;
  if (lines.length > maxLines) {
    out = lines.slice(lines.length - maxLines).join("\n");
    clipped = true;
  }

  // Char cap (tail). The char-slice may cut mid-line; a leading partial line
  // is acceptable for a prompt excerpt.
  if (out.length > maxChars) {
    out = out.slice(out.length - maxChars);
    clipped = true;
  }

  return { text: out, clipped };
}
