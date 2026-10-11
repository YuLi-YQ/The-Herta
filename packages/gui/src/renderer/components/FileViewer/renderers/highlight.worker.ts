import { highlightToHtml } from "./highlight.js";

/**
 * The viewer's highlighter on its own thread (ADR 0068 §12, 2026-09-22).
 *
 * This file is the worker's entry: Vite bundles it as its own chunk from the
 * `new Worker(new URL("./highlight.worker.ts", import.meta.url))` expression
 * in `highlighter.ts`, highlight.js core and the curated languages inside.
 * Its whole job is the same `highlightToHtml` the main thread would have
 * run, on this thread instead. It never touches a DOM (there is none here)
 * and never throws to its caller — an unknown language or an oversize file
 * is `null`, exactly as on the main thread.
 */

/** One request to the worker. `id` pairs the reply with its request — the
 *  worker answers in order, but the client does not rely on that. */
export interface HighlightRequest {
  readonly id: number;
  readonly code: string;
  readonly language: string;
}

/** The worker's answer: `highlightToHtml`'s result for the request. */
export interface HighlightReply {
  readonly id: number;
  readonly html: string | null;
}

addEventListener("message", (event: MessageEvent<HighlightRequest>) => {
  const { id, code, language } = event.data;
  const reply: HighlightReply = { id, html: highlightToHtml(code, language) };
  postMessage(reply);
});
