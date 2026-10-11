import { stripDisplayUnsafe } from "@herta/core/text-sanitize";

/**
 * Append-aware wrapper over `stripDisplayUnsafe` for the LIVE stream lanes
 * (perf 2026-08-25). The streaming bubble scrubbed the FULL raw stream on
 * every render — O(reply) per reveal frame. The scrub is a per-code-unit
 * character class, so for an append-only input it distributes over
 * concatenation: scrub(prefix + suffix) === scrub(prefix) + scrub(suffix) —
 * EXCEPT across a surrogate boundary. The `u`-flag class matches a
 * surrogate only when it is unpaired, so a high surrogate at the end of
 * the old prefix (a delta split an astral pair) may become a valid pair
 * once the suffix arrives; scrubbing the halves separately would drop
 * both. When the cached prefix ends in a high surrogate — or the input is
 * not an append at all (retract, replaced turn) — this falls back to a
 * full scrub. Output always equals `stripDisplayUnsafe(raw)` exactly.
 */
export interface IncrementalScrubStep {
  readonly text: string | null;
  /** Chars actually scrubbed this call (suffix on the append fast path). */
  readonly scanned: number;
}

export interface IncrementalScrubber {
  next(raw: string | null): IncrementalScrubStep;
}

export function createIncrementalScrubber(): IncrementalScrubber {
  let raw = "";
  let out = "";
  return {
    next(nextRaw: string | null): IncrementalScrubStep {
      if (nextRaw === null) {
        raw = "";
        out = "";
        return { text: null, scanned: 0 };
      }
      const prev = raw;
      raw = nextRaw;
      const lastPrev = prev.charCodeAt(prev.length - 1); // NaN when empty
      const pairMayComplete = lastPrev >= 0xd800 && lastPrev <= 0xdbff;
      if (
        !pairMayComplete &&
        nextRaw.length >= prev.length &&
        nextRaw.startsWith(prev)
      ) {
        const suffix = nextRaw.slice(prev.length);
        out += stripDisplayUnsafe(suffix);
        return { text: out, scanned: suffix.length };
      }
      out = stripDisplayUnsafe(nextRaw);
      return { text: out, scanned: nextRaw.length };
    },
  };
}
