/**
 * Fence-aware speech segmenter (slice 5 — Q1/Q2 of the output-hardening
 * review). Splits one committed `herta` block's text into presentation
 * segments: fenced ``` regions become `code` segments (rendered as a plain
 * monospace sub-block), and the prose between them splits on blank lines
 * into paragraph units (rendered as a stacked-bubble sequence).
 *
 * PURE PRESENTATION over an unchanged record (D7, mirroring
 * `group-record.ts`): one `（我 说）` completion stays ONE record block,
 * one supervisor verdict, one selfCorrection anchor — this module only
 * decides how that single block is drawn.
 *
 * Rules (from the design consensus):
 *   - A ``` line opens a fence; the matching ``` line closes it. An
 *     UNCLOSED fence swallows the rest of the text as one code segment
 *     (mid-stream state during a live reveal — the segment simply grows).
 *   - Prose splits on runs of blank lines (\n\n+). Blank lines INSIDE a
 *     fence never split.
 *   - At most MAX_SEGMENTS units; overflow folds into the last segment
 *     (a wall of paragraphs must not become a wall of bubbles).
 *   - Empty/whitespace-only units are dropped.
 */

export type Segment =
  | { readonly kind: "prose"; readonly text: string }
  | { readonly kind: "code"; readonly text: string; readonly lang?: string };

/** Bubble-stack cap. Chat bubbles read as human messages up to a handful;
 *  past that the stack reads as spam and scrolling suffers. Overflow folds
 *  into the final segment rather than being dropped (never lose text). */
export const MAX_SEGMENTS = 5;

/** A fence line: ``` plus an optional info string (```ts). Leading
 *  whitespace tolerated (models indent fences); trailing content after the
 *  opening backticks is the lang tag. */
const FENCE_LINE = /^\s*```([^`\n]*)\s*$/;

export function segmentSpeech(text: string): Segment[] {
  return foldSegments(segmentUnits(text));
}

/** The unfolded unit list — `segmentSpeech` minus the MAX_SEGMENTS cap. The
 *  incremental segmenter composes frozen + live-tail unit runs and must fold
 *  the CONCATENATION, so the two stages are split here. */
function segmentUnits(text: string): Segment[] {
  const lines = text.split("\n");
  const segments: Segment[] = [];

  let proseBuf: string[] = [];
  let codeBuf: string[] | null = null;
  let codeLang: string | undefined;

  const flushProse = (): void => {
    const joined = proseBuf.join("\n");
    proseBuf = [];
    // Split the prose run on blank-line boundaries into paragraph units.
    for (const para of joined.split(/\n\s*\n+/)) {
      const trimmed = para.trim();
      if (trimmed.length > 0) segments.push({ kind: "prose", text: trimmed });
    }
  };

  for (const line of lines) {
    const fence = line.match(FENCE_LINE);
    if (codeBuf === null) {
      if (fence !== null) {
        flushProse();
        codeBuf = [];
        const lang = fence[1]?.trim() ?? "";
        codeLang = lang.length > 0 ? lang : undefined;
      } else {
        proseBuf.push(line);
      }
    } else if (fence !== null && (fence[1]?.trim() ?? "") === "") {
      // Closing fence (a bare ``` line — a lang tag reopens, per CommonMark
      // close fences carry no info string).
      const code = codeBuf.join("\n");
      codeBuf = null;
      // Keep even whitespace-only code interiors out; a code segment must
      // have SOMETHING to show.
      if (code.trim().length > 0) {
        segments.push({
          kind: "code",
          text: code,
          ...(codeLang !== undefined ? { lang: codeLang } : {}),
        });
      }
      codeLang = undefined;
    } else {
      codeBuf.push(line);
    }
  }

  // End of text: an unclosed fence swallows the tail as one code segment
  // (live-reveal mid-fence state, or the model never closed it).
  if (codeBuf !== null) {
    const code = codeBuf.join("\n");
    if (code.trim().length > 0) {
      segments.push({
        kind: "code",
        text: code,
        ...(codeLang !== undefined ? { lang: codeLang } : {}),
      });
    }
  } else {
    flushProse();
  }

  return segments;
}

/** How one overflow unit reads inside the folded final segment (a folded
 *  code unit re-fences without its lang tag — the fold is prose). */
function foldUnitText(s: Segment): string {
  return s.kind === "code" ? `\`\`\`\n${s.text}\n\`\`\`` : s.text;
}

/** Cap: fold overflow into the LAST kept segment so no text is dropped. */
function foldSegments(segments: Segment[]): Segment[] {
  if (segments.length <= MAX_SEGMENTS) return segments;
  const kept = segments.slice(0, MAX_SEGMENTS - 1);
  const folded = segments.slice(MAX_SEGMENTS - 1);
  kept.push({ kind: "prose", text: folded.map(foldUnitText).join("\n\n") });
  return kept;
}

export interface IncrementalSegmentStep {
  readonly segments: readonly Segment[];
  /** Chars examined by this call (boundary scan + closed-chunk + live-tail
   *  segmentation) — the reveal-perf work metric. */
  readonly scanned: number;
}

export interface IncrementalSegmenter {
  next(text: string): IncrementalSegmentStep;
}

/**
 * Append-aware segmenter for the LIVE reveal (perf 2026-08-25). The
 * streaming bubble re-segments the revealed prefix once per rAF frame;
 * batch `segmentSpeech` made that O(full reply) per frame — O(n²) per
 * reply. This exploits the frozen-prefix invariant the reveal guarantees
 * (the revealed text only ever APPENDS, so a segment boundary, once its
 * closing line has fully arrived, never moves):
 *
 *   - A completed whitespace-only line OUTSIDE a fence, the start of a
 *     completed fence-open line, and the end of a completed close-fence
 *     line are FREEZE points: the batch scanner's state is empty there,
 *     so everything before segments independently of everything after.
 *   - Text up to the last freeze point is segmented ONCE (via the same
 *     `segmentUnits`) and cached with stable unit identity — memoized
 *     `SegmentBody` rows bail on identity, so frozen bubbles never
 *     re-tokenize. Only the live tail (the still-growing unit) is
 *     re-segmented per call.
 *   - The MAX_SEGMENTS fold re-derives per call, but the formatted join
 *     of FROZEN overflow units is cached, so a many-paragraph reply
 *     doesn't re-join its whole overflow every frame.
 *
 * A non-append input (the retract morph shrinking, a replaced turn)
 * resets the cache and re-derives from scratch — output always equals
 * `segmentSpeech(text)` exactly (the equivalence property test replays
 * every prefix to pin this).
 */
export function createIncrementalSegmenter(): IncrementalSegmenter {
  let lastText = "";
  let frozen: Segment[] = [];
  let frozenIndex = 0;
  /** Formatted "\n\n"-join of frozen overflow units (index ≥ MAX-1). */
  let frozenFoldText: string | null = null;
  let frozenFoldCount = 0;

  const reset = (): void => {
    lastText = "";
    frozen = [];
    frozenIndex = 0;
    frozenFoldText = null;
    frozenFoldCount = 0;
  };

  return {
    next(text: string): IncrementalSegmentStep {
      // Append check: native prefix memcmp — O(prev) but ~two orders
      // cheaper than the per-line regex scans it guards, and it is what
      // makes a non-append input SAFE rather than silently divergent.
      if (!text.startsWith(lastText)) reset();
      lastText = text;
      let scanned = 0;

      // Walk COMPLETED lines beyond the freeze boundary looking for new
      // freeze points. Fence parity starts closed — freeze points are
      // always outside fences by construction.
      let i = frozenIndex;
      let fence = false;
      let freezeAt = frozenIndex;
      for (;;) {
        const nl = text.indexOf("\n", i);
        if (nl === -1) break;
        const line = text.slice(i, nl);
        scanned += line.length + 1;
        const m = FENCE_LINE.exec(line);
        if (!fence) {
          if (m !== null) {
            // Prose before an opened fence is final; the fence itself is
            // not (its close may still arrive) — freeze BEFORE the line.
            freezeAt = i;
            fence = true;
          } else if (/^\s*$/.test(line)) {
            // A completed separator line: earlier paragraphs are final.
            freezeAt = nl + 1;
          }
        } else if (m !== null && (m[1]?.trim() ?? "") === "") {
          fence = false;
          freezeAt = nl + 1;
        }
        i = nl + 1;
      }

      // Freeze the closed chunk. It starts and ends at clean boundaries,
      // so batch segmentation reproduces it verbatim, with unit identity
      // that never changes again.
      if (freezeAt > frozenIndex) {
        const chunk = text.slice(frozenIndex, freezeAt);
        scanned += chunk.length;
        frozen.push(...segmentUnits(chunk));
        frozenIndex = freezeAt;
      }

      // The live tail: the still-growing unit(s) past the last freeze point.
      const tail = text.slice(frozenIndex);
      scanned += tail.length;
      const tailUnits = segmentUnits(tail);
      const total = frozen.length + tailUnits.length;
      if (total <= MAX_SEGMENTS) {
        return { segments: frozen.concat(tailUnits), scanned };
      }

      // Fold, reusing the cached join of the frozen overflow.
      const keptCount = MAX_SEGMENTS - 1;
      const kept: Segment[] = [];
      for (let k = 0; k < keptCount; k++) {
        const seg =
          k < frozen.length ? frozen[k] : tailUnits[k - frozen.length];
        if (seg !== undefined) kept.push(seg);
      }
      if (
        frozen.length > keptCount &&
        frozenFoldCount < frozen.length - keptCount
      ) {
        const parts: string[] = frozenFoldText === null ? [] : [frozenFoldText];
        for (let k = keptCount + frozenFoldCount; k < frozen.length; k++) {
          const seg = frozen[k];
          if (seg !== undefined) parts.push(foldUnitText(seg));
        }
        frozenFoldText = parts.join("\n\n");
        frozenFoldCount = frozen.length - keptCount;
      }
      const foldParts: string[] = [];
      if (frozen.length > keptCount && frozenFoldText !== null) {
        foldParts.push(frozenFoldText);
      }
      for (
        let k = Math.max(0, keptCount - frozen.length);
        k < tailUnits.length;
        k++
      ) {
        const seg = tailUnits[k];
        if (seg !== undefined) foldParts.push(foldUnitText(seg));
      }
      kept.push({ kind: "prose", text: foldParts.join("\n\n") });
      return { segments: kept, scanned };
    },
  };
}
