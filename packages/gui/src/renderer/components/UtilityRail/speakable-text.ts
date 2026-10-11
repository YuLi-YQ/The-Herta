/**
 * Speakable-prose classifier for the voice wave (SPEC 2026-06-11
 * voice-wave §1/§3): nobody speaks a code block or a table row, so those
 * regions must not kick the wave. Line-based scan:
 *   - a line whose trimmed start is ``` toggles fence state and is itself
 *     non-speakable;
 *   - lines inside a fence are non-speakable;
 *   - lines whose trimmed start is | are table rows — non-speakable;
 *   - everything else is speakable (inline `code` spans included — they
 *     are read aloud mid-sentence). Newline characters are not counted.
 *
 * Streaming note: a PARTIAL fence line ("``" while the third backtick is
 * still in flight) transiently counts as prose; once it completes, the
 * total speakable count can DROP. Callers must clamp negative growth to
 * zero (the hook does) — the few spurious kicks are imperceptible.
 */
export interface SpeakableScan {
  readonly count: number;
  /** Last speakable character (for punctuation classification), or null. */
  readonly last: string | null;
}

export function scanSpeakable(text: string): SpeakableScan {
  let count = 0;
  let last: string | null = null;
  let inFence = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue; // the fence line itself is not spoken
    }
    if (inFence) continue;
    if (trimmed.startsWith("|")) continue; // table row
    const chars = [...line];
    count += chars.length;
    const tail = [...line.trimEnd()];
    const lastChar = tail[tail.length - 1];
    if (lastChar !== undefined) last = lastChar;
  }
  return { count, last };
}
