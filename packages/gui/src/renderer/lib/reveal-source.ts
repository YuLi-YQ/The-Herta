/**
 * The one reveal source (perf 2026-08-25). StreamingReply owns the paced
 * per-frame reveal of the live reply; the voice-wave envelope used to run
 * a SECOND independent `useRevealedText` over the raw stream to watch the
 * same growth — a duplicate rAF loop that re-rendered the aura card every
 * frame. Instead, StreamingReply publishes its revealed text here and the
 * envelope subscribes imperatively (kicks accumulate in refs and are
 * drained by the canvas loop — no React state, no re-renders).
 *
 * Renderer-local presentation state only (D7): the record, the store, and
 * the wire never see this. Values are the SCRUBBED revealed prefix — what
 * is actually on screen — so the wave breathes with the visible
 * typewriter, including the galaxy-row hold (Conversation feeds
 * StreamingReply `visibleStreamingText`, so the wave starts when the
 * reply visually enters).
 */
type RevealListener = (text: string | null) => void;

let current: string | null = null;
const listeners = new Set<RevealListener>();

export function publishRevealedSpeech(text: string | null): void {
  if (current === text) return;
  current = text;
  for (const listener of [...listeners]) listener(text);
}

export function getRevealedSpeech(): string | null {
  return current;
}

export function subscribeRevealedSpeech(listener: RevealListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
