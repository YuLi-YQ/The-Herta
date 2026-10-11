import { type RefObject, useEffect, useRef } from "react";
import {
  createIncrementalScrubber,
  type IncrementalScrubber,
} from "../../lib/incremental-strip.js";
import { journeyMarkAfterPaint } from "../../lib/journey.js";
import { measureRevealSpan } from "../../lib/reveal-perf.js";
import { publishRevealedSpeech } from "../../lib/reveal-source.js";
import {
  createIncrementalSegmenter,
  type IncrementalSegmenter,
} from "../../lib/segment-speech.js";
import { SegmentBody } from "./HertaBubble.js";
import { MorphClone } from "./MorphClone.js";
import { useRetractMorph } from "./useRetractMorph.js";
import { useRevealedText } from "./useRevealedText.js";

export interface StreamingReplyProps {
  /** Conversation language, for the 板砖→Brick display alias while streaming. */
  readonly lang: "zh" | "en";
  readonly streamingText: string | null;
  readonly retryText: string | null;
  readonly retracting: boolean;
  readonly retractKeepLen: number | null;
  readonly reduced: boolean;
  /** True while the incoming-rise clone owns the visual — the flow bubble
   *  holds its slot invisibly until the rise settles. */
  readonly hideStreaming: boolean;
  /** True while the incoming-rise MorphClone should render (mounted by the
   *  parent's streamingText null→value edge detection). */
  readonly showIncomingClone: boolean;
  /** The flow streaming bubble — the parent's rise animation measures it. */
  readonly streamingBubbleRef: RefObject<HTMLDivElement>;
  /** The flying clone — the parent's rise animation drives it. */
  readonly incomingCloneRef: RefObject<HTMLDivElement>;
  readonly overlayRef: RefObject<HTMLDivElement>;
  /** Called whenever the revealed text advances — the parent keeps the pinned
   *  autoscroll following the growth without re-rendering per frame. */
  readonly onGrow: () => void;
}

/**
 * The live streaming bubble + its incoming-rise mirror clone, isolated into a
 * leaf so the per-FRAME reveal state (`useRevealedText` commits once per rAF
 * frame while tokens stream) re-renders only this subtree. Before the split,
 * that state lived in `Conversation`, so every reveal frame re-rendered the
 * entire conversation — O(all blocks) × 60/s on long sessions, the GUI's
 * primary streaming jank source.
 *
 * The morph EDGES (mount/hide flags, rise geometry) stay in `Conversation`,
 * which owns the null→value detection on the per-delta `streamingText`; this
 * component owns only the per-frame text fill.
 */
export function StreamingReply(props: StreamingReplyProps): JSX.Element | null {
  // Pace the live stream into an even, per-frame reveal so bursty token
  // arrival doesn't make the (content-sized) bubble grow in jerky multi-char
  // jumps. During a retract the prefix-preserving morph owns the text: it
  // shrinks the vetoed candidate back to the confirmed common prefix with
  // the retry stream, then types the retry forward from there (reduced
  // motion mirrors the retry directly). Animation policy is a renderer
  // preference (per SPEC §5.4 / D7); the store only flags `retracting` and
  // buffers `retryText`.
  // Display scrub (slice 2): live deltas are RAW model tokens — a bidi
  // override or ANSI introducer must never reach the DOM. Applied to both
  // stream lanes so the retract morph diffs two consistently-scrubbed
  // strings. Caveat: the server-computed `keepLen` indexes the raw stream;
  // for normal text the scrub is the identity so indices agree — only a
  // hostile stream can shift the erase floor by a few chars (cosmetic).
  // Both derivations are APPEND-AWARE (perf 2026-08-25): this component
  // re-renders once per reveal frame, and scrubbing/segmenting the full
  // text each time was O(reply) per frame — O(n²) per reply. The caches
  // live in a ref (created once per mount) and re-derive from scratch on
  // any non-append input, so output stays byte-equal to the batch path.
  const derive = useRef<{
    streaming: IncrementalScrubber;
    retry: IncrementalScrubber;
    segmenter: IncrementalSegmenter;
  } | null>(null);
  if (derive.current === null) {
    derive.current = {
      streaming: createIncrementalScrubber(),
      retry: createIncrementalScrubber(),
      segmenter: createIncrementalSegmenter(),
    };
  }
  const d = derive.current;
  const streamingText = measureRevealSpan(
    "reveal.strip",
    () => d.streaming.next(props.streamingText),
    (r) => r.scanned,
  ).text;
  const retryText = measureRevealSpan(
    "reveal.strip",
    () => d.retry.next(props.retryText),
    (r) => r.scanned,
  ).text;
  const revealed = useRevealedText(streamingText, props.reduced, props.lang);
  const morph = useRetractMorph({
    retracting: props.retracting,
    vetoed: streamingText,
    retryText,
    revealed,
    keepLen: props.retractKeepLen,
    reduced: props.reduced,
    lang: props.lang,
  });
  const bubbleText = props.retracting ? morph : revealed;

  // Keep the pinned autoscroll following the fill. Cheap: the parent's
  // callback is a bounds check + optional scrollIntoView, no state.
  // `bubbleText` is deliberately a dep — it isn't read inside, but each
  // reveal frame changing it is exactly the "content grew" signal to follow.
  const { onGrow } = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: bubbleText is the growth trigger, not an input
  useEffect(() => {
    onGrow();
  }, [bubbleText, onGrow]);

  // Publish the revealed prefix to the shared reveal source: the voice-wave
  // envelope watches speech growth there instead of running a second
  // independent reveal over the raw stream (perf 2026-08-25). During a
  // retract `revealed` holds still (the morph owns the visual), so the
  // shrink contributes no growth — matching the wave-quiets-on-veto rule.
  useEffect(() => {
    publishRevealedSpeech(revealed);
  }, [revealed]);
  useEffect(() => () => publishRevealedSpeech(null), []);

  // The send journey ends at the reply's first VISIBLE glyph — after the
  // in-flight row's hold and the reveal's pacing, which the store's
  // `send:first-delta` does not see. Once per stream.
  const firstShown = useRef(false);
  const hasGlyph = revealed !== null && revealed.length > 0;
  useEffect(() => {
    if (props.streamingText === null) firstShown.current = false;
    else if (hasGlyph && !firstShown.current) {
      firstShown.current = true;
      journeyMarkAfterPaint("send:first-painted");
    }
  }, [hasGlyph, props.streamingText]);

  // Live bubble STACK (slice 5): the revealed prefix re-segments per frame.
  // The reveal is an append-only prefix, so a `\n\n` boundary, once crossed,
  // never moves — earlier bubbles are stable; only the LAST segment grows
  // (and carries the caret). The incremental segmenter EXPLOITS that
  // invariant (perf 2026-08-25): frozen segments keep their identity across
  // frames, so the memoized SegmentBody rows skip re-tokenizing them and
  // only the live tail re-derives. During a retract the morph string
  // shrinks and the stack re-derives from scratch each step (the
  // segmenter's non-append reset) — trailing bubbles empty out and unmount
  // as the erase walks back. An unclosed ``` fence segments as code
  // mid-stream, so leaked code renders monospace as it streams.
  const segments =
    bubbleText === null
      ? []
      : measureRevealSpan(
          "reveal.segment",
          () => d.segmenter.next(bubbleText),
          (r) => r.scanned,
        ).segments;
  const showCaret = !props.retracting || props.retryText !== null;

  return (
    <>
      {bubbleText !== null &&
        (segments.length > 0 ? segments : [null]).map((seg, i, arr) => {
          const isLast = i === arr.length - 1;
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: stable positional split of one growing string
              key={i}
              className={`message-row herta-row${isLast ? "" : " is-stack-mid"}`}
              data-testid={
                i === 0 ? "streaming-bubble" : "streaming-bubble-cont"
              }
              style={props.hideStreaming ? { visibility: "hidden" } : undefined}
            >
              {/* SegmentBody renders prose in the bubble, code as a bare
                  monospace card (see HertaBubble). The rise clone measures
                  the FIRST row's body.

                  Composing caret: the verdict-gated pacing HOLDS the stream
                  near the end while the supervisor thinks (SPEC stream-pacing
                  2026-06-11) — without a live affordance that pause read as
                  the app being stuck (user report 2026-07-04). The caret
                  pulses for the whole stream so any hold reads as "still
                  composing". During a retract it hides ONLY for the erase
                  (the deletion motion owns the visual); once retry deltas
                  buffer (the fill phase — which has its own TTFT/starvation
                  gaps) it returns, so the re-speak never sits caretless and
                  frozen. Gone with the finalized block. Lives in the LAST
                  row of the stack — the one still growing. */}
              <SegmentBody
                seg={seg}
                lang={props.lang}
                caret={isLast && showCaret}
                {...(i === 0 ? { innerRef: props.streamingBubbleRef } : {})}
              />
            </div>
          );
        })}
      {props.showIncomingClone && props.streamingText !== null && (
        <MorphClone
          ref={props.incomingCloneRef}
          overlay={props.overlayRef}
          variant="herta"
          text={segments[0]?.text ?? revealed ?? ""}
          lang={props.lang}
        />
      )}
    </>
  );
}
