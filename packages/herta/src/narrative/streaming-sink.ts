import type { TerminalRecord, TerminalRecordBlock } from "@herta/core";

/**
 * Streaming sink for the v0.2 actor turn loop. The actor calls these methods
 * during streamed generation; the implementation (typically a CLI
 * `NarrativeRenderer` wrapper) decides what to do with the events.
 *
 * Optional via `ActorTurnDeps.sink?`. When absent, the actor loop behaves
 * identically to pre-Slice-9: buffers tokens internally and commits atomic
 * blocks at end-of-stream. Tests and headless callers can omit the sink.
 *
 * Method order per Herta block (primary OR beat):
 *   1. flushBlocks(record)       — optional, idempotent. Renders any
 *                                  side-effect blocks committed since
 *                                  last call (system blocks from inline
 *                                  tools or backend events).
 *   2. streamHertaToken(text)*   — one or more times, as text-delta events
 *                                  arrive. Implementations should write
 *                                  to stdout in real-time.
 *   3. endHertaStream()          — exactly once when the stream's stop
 *                                  sequence fires. Implementations should
 *                                  advance their cursor by 1 to claim
 *                                  the position the herta block will
 *                                  occupy in TerminalRecord.
 *
 * Repeats per iteration (primary block + inline calls' system blocks +
 * subsequent iterations) and per beat (within `@板砖` execution).
 *
 * SPEC v0.2 Slice 9.
 */
/**
 * Controller returned by `ActorStreamingSink.slowStreamSpeech`. The
 * sink emits the speech text across time (pacing per-char); the
 * controller lets the caller observe completion or steer the
 * emission to a terminal state.
 *
 * State transitions and promise semantics:
 *   - `done` resolves once the full text has reached the sink via
 *     any terminal path (natural completion or `fastForward`). If
 *     `cancelAndBackspace` fires before the text is fully emitted,
 *     `done` REJECTS with `Error("slow-stream cancelled")`.
 *   - `fastForward` drains the remaining text at the renderer's
 *     minimum per-char delay (no jitter, no punctuation pauses).
 *     Resolves once the tail has been emitted. Idempotent — calling
 *     after `done` has resolved is a no-op that resolves immediately.
 *   - `cancelAndBackspace` stops forward emission and hands the
 *     retraction to the render surface. Sinks MAY block until their
 *     retract animation completes (the CLI renderer does — a terminal is
 *     a single serial surface, so the retraction must finish before retry
 *     text can be written); the GUI sink resolves
 *     immediately so the actor's retry can race the renderer's
 *     prefix-preserving morph. Idempotent.
 *
 * Only one terminal method should be called per controller. Calling
 * both `fastForward` and `cancelAndBackspace` on the same controller
 * is undefined behavior (implementations may throw or behave
 * unpredictably — tests must not rely on either).
 *
 * SPEC v0.2 Supervisor streaming §4.
 */
export interface SlowStreamController {
  readonly done: Promise<void>;
  fastForward(): Promise<void>;
  cancelAndBackspace(): Promise<void>;
  /**
   * INSTANT drain for interrupt / reveal-ceiling paths (slice 3): cancel any
   * pending tick, emit every remaining character in ONE delta, finish.
   * Unlike `fastForward` — the OK-verdict resume, which drains PACED so the
   * verdict is never audible as a speed change — this is deliberately
   * abrupt: the user asked to stop, or the reveal hit its wall-clock
   * ceiling. It fast-forwards, never truncates: the flushed text equals the
   * text the turn commits. Synchronous, idempotent, and a no-op after any
   * terminal state (including after `cancelAndBackspace`). Optional — a
   * sink without it keeps the old loop-boundary-only interrupt behavior.
   */
  flushRemainder?(): void;
}

/**
 * Controller returned by `ActorStreamingSink.slowStreamSpeechLive`. Like
 * `SlowStreamController`, but the speech text arrives incrementally — the
 * caller pushes chunks as the model generates them, then signals completion.
 * The sink reveals from a growing internal buffer: at base cadence while input
 * is open (so a backlog builds — the reveal lags generation), then the existing
 * verdict-pending ramp/hold (`pacingDecision`) applies to whatever tail remains
 * once `finishInput` makes the total length known.
 *
 * begin/end discipline matches `slowStreamSpeech`: `beginHertaStream("speech")`
 * fires at the first emitted character (deferred — never fires if zero tokens
 * are pushed); `endHertaStream()` fires exactly once on any terminal path
 * (drain, fastForward, or cancelAndBackspace).
 *
 * Precondition: callers invoke `fastForward` / `cancelAndBackspace` only after
 * `finishInput` (the supervisor verdict that drives them lands after generation
 * completes). On an unfinished stream these wait for `finishInput` to drain
 * rather than truncating still-arriving input.
 *
 * SPEC: docs/superpowers/specs/2026-06-28-live-feed-supervised-reveal-design.md §2.
 */
export interface LiveSlowStreamController extends SlowStreamController {
  /** Append a chunk to the growing reveal buffer. Safe to call after the cursor
   *  has drained the buffer — the reveal re-arms from its starved hold. No-op
   *  after `finishInput` or a terminal method. */
  pushToken(text: string): void;
  /** Signal that no more input will arrive. `total` is now final, so the
   *  verdict-pending ramp/hold applies to the remaining tail. */
  finishInput(): void;
}

export interface ActorStreamingSink {
  /**
   * Called once per Herta block before any token streaming. The actor
   * determines surface from the first 1–2 chars of the completion stream
   * (`想）` vs `说）`) or directly when the open tag was forced to speech.
   *
   * Implementations:
   *   - "speech":  prepare to receive token deltas via `streamHertaToken`.
   *   - "thought": write the dim `(思考中…)` indicator; subsequent
   *                `streamHertaToken` calls should no-op (thought text
   *                is hidden from the user).
   *
   * SPEC v0.2 Slice 10 §6.1.
   */
  beginHertaStream(surface: "speech" | "thought"): void;

  /** Emit a token chunk to the render surface (typically stdout in Herta-bright).
   *  For thought surface: implementations should no-op. */
  streamHertaToken(text: string): void;

  /** Mark a Herta block's stream as finished. For speech: write a trailing
   *  newline. For thought: clear the indicator line via `\r\x1b[K`. In BOTH
   *  cases the implementation should advance its internal cursor by 1 — the
   *  block (whether speech or thought) occupies a position in TerminalRecord
   *  that `flushBlocks` must not re-walk. (Thought blocks are skipped at
   *  RENDER time by `flushBlocks`, not skipped at CURSOR time.) */
  endHertaStream(): void;

  /** Project any blocks committed to the record since the previous flush.
   *  Idempotent (advance an internal cursor; never re-walk a block).
   *  Whether `surface: "thought"` blocks are SHOWN is a render-surface choice,
   *  NOT a contract: the CLI sink (NarrativeRenderer) inlines to the terminal,
   *  so it skips thought blocks (internal monologue, SPEC §6.2); the GUI sink
   *  (BusActorStreamingSink) projects EVERY block to its record stream so the
   *  stream stays index-aligned with the `session.record` reset-snapshot, and
   *  the GUI filters thought at render time. Do NOT add a thought-skip to a
   *  stream-projecting implementation — it would drift the cursor off the
   *  canonical record indices. */
  flushBlocks(record: TerminalRecord): void;

  /**
   * Optional (D1, mid-stream durability): install a persistence hook the sink
   * invokes for each block as it is flushed. Called BEFORE the block is
   * projected to the render surface (durable-first: a persist failure fails the
   * turn before the user sees the block). Rides the same canonical-ordered,
   * cursor-guarded walk as `flushBlocks`, so blocks excluded by the cursor
   * (loaded record on resume, opening seed) are never re-persisted. A sink that
   * implements this owns persistence; the driver then SKIPS its batch-after-turn
   * persist for that sink. Sinks that omit it (the CLI `NarrativeRenderer`,
   * headless/test fakes) leave persistence to the driver's batch fallback.
   *
   * Why a hook rather than a constructor arg: the driver owns the (swappable,
   * via `/resume`) persister; the hook reads it at call time so a `setPersister`
   * swap is reflected without re-wiring the sink.
   */
  setPersistHook?(hook: (block: TerminalRecordBlock) => void): void;

  /**
   * Optional (D3, streaming opening): settle an opening-seed block on the render
   * surface after it has streamed in via `slowStreamSpeech`, WITHOUT persisting
   * it. The seed was written to disk at session creation (so a mid-stream close
   * never loses it); persisting again here via the flush hook would duplicate
   * it. Emits the block on the record stream (the renderer settles its streaming
   * bubble to it) and advances the cursor so a later `flushBlocks` does not
   * re-emit it. Sinks that omit this leave the seed unsettled (the GUI sink
   * implements it; the CLI seeds its opening as a loaded block 0 instead).
   */
  commitOpeningSeed?(block: TerminalRecordBlock): void;

  /**
   * Optional: render `text` as a `（我 说）` speech block with
   * per-character pacing, returning a controller for parallel
   * supervision. When implemented, the actor uses this on the
   * supervisor-enabled phase-2 speech path so the user sees the
   * candidate appearing while the supervisor evaluates it.
   *
   * The optional `opts.verdictPending` promise lets the slow-stream
   * coordinate its cadence with the supervisor LLM call: while the
   * promise is unresolved AND the cursor is in the back portion of
   * the text, the per-char delay is multiplied so the visible
   * stream doesn't finish dramatically before the verdict arrives.
   * The actor passes a promise that resolves (regardless of OK/veto
   * outcome) when the supervisor stream completes. Sinks that
   * ignore this signal degrade gracefully — the user just sees the
   * old behavior (fast streaming, then an awkward pause until
   * verdict).
   *
   * Sinks that omit `slowStreamSpeech` entirely (test fakes,
   * headless callers) cause the actor to fall back to the "defer
   * until verdict, then render in one shot via streamHertaToken"
   * path. See spec §10.
   *
   * Implementations MUST:
   *   - Call `beginHertaStream("speech")` at the moment the first
   *     character is emitted (deferred-begin).
   *   - Call `endHertaStream()` exactly once when emission ends via
   *     ANY terminal path (natural completion, fastForward, or
   *     cancelAndBackspace). This advances the sink's cursor by 1
   *     regardless of whether visible text was retained — matching
   *     the herta-speech block that will be appended to the record.
   *
   * SPEC v0.2 Supervisor streaming §4, §6 (begin/end discipline).
   */
  readonly slowStreamSpeech?: (
    text: string,
    opts?: {
      verdictPending?: Promise<void>;
      /** Per-char base cadence (ms) for a VOICED stream, replacing the sink's
       *  default. Set so the reveal spans ≈ the clip duration (wav-matched
       *  opening cadence, SPEC 2026-06-23). Omitted → the sink's own base. */
      baseMsOverride?: number;
      /** This stream already HAS a voice (the opening's recorded clip):
       *  a sink with a speech synthesizer (ADR 0042) must not voice it a
       *  second time. Omitted → the sink may voice the stream. */
      unvoiced?: boolean;
    },
  ) => SlowStreamController;

  /**
   * Optional (Bug 2, 2026-06-27): emit the supervisor-veto retract floor — the
   * code-point length of the shared prefix between the vetoed candidate and the
   * final retry. The GUI sink forwards it as a `retractFloor` control event so
   * the renderer's backward erase halts at the divergence instead of wiping to
   * empty. Sinks without a prefix morph (the CLI) omit it — its full backspace
   * already ran in `cancelAndBackspace`.
   */
  emitRetractFloor?(keepLen: number): void;

  /**
   * Optional. Like `slowStreamSpeech`, but the text arrives incrementally via
   * the returned controller's `pushToken`/`finishInput` rather than all at once.
   * Used by the supervised first-pass speech so the candidate appears at TTFT
   * while the supervisor evaluates the completed candidate. Sinks that omit it
   * (CLI, headless, test fakes) cause the actor to fall back to the
   * `deferStreaming` + `slowStreamSpeech`/replay path.
   *
   * SPEC: docs/superpowers/specs/2026-06-28-live-feed-supervised-reveal-design.md §2/§4.
   */
  readonly slowStreamSpeechLive?: (opts?: {
    verdictPending?: Promise<void>;
    baseMsOverride?: number;
    /** See `slowStreamSpeech`. */
    unvoiced?: boolean;
  }) => LiveSlowStreamController;
}

/**
 * Returns the largest index `i` such that `buffer.slice(0, i)` is safe to
 * emit without risking partial-stop-sequence corruption. Tokens beyond `i`
 * are held in case the next delta completes a stop sequence.
 *
 * Algorithm: from the end of the buffer, check successively longer tails
 * (1 char, 2 chars, …, up to maxStopLen-1 chars). If any tail is a prefix
 * of any stop sequence, hold the tail. The longest matching prefix wins.
 *
 * Edge cases:
 *   - Empty buffer → 0.
 *   - No stop sequences in list → buffer.length (nothing to hold).
 *   - Buffer ends in the FULL stop sequence → the full sequence is held
 *     (returns `buffer.length - stop.length`).
 *
 * SPEC v0.2 Slice 9 §6.
 */
export function safeEmitBoundary(
  buffer: string,
  stopSeqs: readonly string[],
): number {
  if (buffer.length === 0) return 0;
  if (stopSeqs.length === 0) return buffer.length;

  let maxStopLen = 0;
  for (const stop of stopSeqs) {
    if (stop.length > maxStopLen) maxStopLen = stop.length;
  }
  if (maxStopLen === 0) return buffer.length;

  // Check successively longer tails. The LONGEST matching prefix wins
  // (we want to hold as few chars as needed; but if a longer tail matches
  // a longer prefix, that's the right hold).
  const maxCheck = Math.min(maxStopLen, buffer.length);
  let longestHoldLen = 0;
  for (let tailLen = 1; tailLen <= maxCheck; tailLen++) {
    const tail = buffer.slice(buffer.length - tailLen);
    for (const stop of stopSeqs) {
      if (stop.startsWith(tail)) {
        if (tailLen > longestHoldLen) longestHoldLen = tailLen;
      }
    }
  }
  return buffer.length - longestHoldLen;
}

/**
 * Defensive strip of a stop sequence from the end of a buffered string.
 * Used at end-of-stream to remove the close tag if the provider emitted
 * it before the stop signal fired. Matches the existing `actor-turn.ts`
 * post-buffer strip behavior.
 *
 * Uses `lastIndexOf` so multiple occurrences (pathological) strip the
 * trailing one and leave earlier text intact.
 */
export function stripStopSequence(buffer: string, stop: string): string {
  const idx = buffer.lastIndexOf(stop);
  return idx >= 0 ? buffer.slice(0, idx) : buffer;
}

/**
 * Strip a *dangling* stop-marker prefix from the end of an end-of-stream
 * buffer.
 *
 * During streaming, `safeEmitBoundary` holds back any trailing tail that is a
 * prefix of a stop sequence, pending the next delta that might complete the
 * marker. When the stream FINISHES with such a tail still unresolved — e.g.
 * the model emitted `（/` (the 2-char prefix of `（/我 说）`) but the stream
 * ended before `我 说）` arrived — that orphaned prefix would otherwise leak
 * into the committed block. `stripStopSequence` only removes a COMPLETE marker
 * (its `lastIndexOf` never matches a partial), and `String.trim()` only
 * removes whitespace (the full-width `（` U+FF08 is not whitespace), so neither
 * catches it.
 *
 * This removes exactly the tail `safeEmitBoundary` would hold — it is the
 * inverse of the streaming-time hold — so nothing withheld from the sink and
 * never completed is committed to the record. A buffer ending in clean prose
 * (no stop-prefix tail) is returned unchanged. Any orphan whitespace left
 * behind (e.g. the `\n` before `（/`) is the caller's existing `.trim()` /
 * whitespace-skip to remove.
 *
 * SPEC v0.2 Slice 9 §6 (companion to `safeEmitBoundary`).
 */
export function stripDanglingStopPrefix(
  buffer: string,
  stopSeqs: readonly string[],
): string {
  return buffer.slice(0, safeEmitBoundary(buffer, stopSeqs));
}
