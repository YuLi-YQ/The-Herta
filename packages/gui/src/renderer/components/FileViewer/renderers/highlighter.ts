import type { HighlightReply, HighlightRequest } from "./highlight.worker.js";

/**
 * The viewer's highlighter, off the main thread (ADR 0068 §12, 2026-09-22).
 *
 * `highlight.ts` tokenizes up to `MAX_HIGHLIGHT_CHARS` synchronously — on a
 * 300K-character source that is a main-thread task of hundreds of
 * milliseconds, run at the moment the panel opens a code file, while the
 * record is still streaming and the voice is still typing. The tokens are
 * only ever adopted asynchronously (CodeView paints plain text first and
 * colours in when the answer lands), so nothing about the viewer needs them
 * computed on the thread that paints. This client sends the work to a
 * dedicated worker — the shape pdf.js already uses in the same panel (ADR
 * 0054 §5; the CSP's `worker-src 'self'` is that decision) — and keeps the
 * main-thread path as the fallback: an environment without `Worker`
 * (jsdom), a worker that fails to construct, or one that errors mid-flight
 * each answer through the lazily imported `highlight.ts`, exactly as before.
 *
 * What stays on the main thread: DOMPurify's pass over the returned HTML and
 * its adoption into the `<pre>` — DOM work that cannot leave it.
 */

type Highlighter = typeof import("./highlight.js");

export interface HighlightClientDeps {
  /** Construct the worker, or null when there is none to be had. May throw;
   *  a throw counts as null. */
  readonly spawnWorker: () => Worker | null;
  /** The main-thread highlighter, loaded lazily (it is its own chunk). */
  readonly loadHighlighter: () => Promise<Highlighter>;
}

export interface HighlightClient {
  /** highlight.js HTML for `code`, or null when the language is unknown or
   *  the code is too long — `highlightToHtml`'s answer, from whichever
   *  thread computed it. Never rejects. */
  highlight(code: string, language: string): Promise<string | null>;
}

interface Pending {
  readonly code: string;
  readonly language: string;
  readonly resolve: (html: string | null) => void;
}

export function createHighlightClient(
  deps: HighlightClientDeps,
): HighlightClient {
  // undefined: not tried yet. null: tried and unavailable, or retired after
  // an error — from then on every request answers on the main thread.
  let worker: Worker | null | undefined;
  const pending = new Map<number, Pending>();
  let nextId = 1;

  const onMainThread = (
    code: string,
    language: string,
  ): Promise<string | null> =>
    deps.loadHighlighter().then(
      (h) => h.highlightToHtml(code, language),
      () => null,
    );

  const spawn = (): Worker | null => {
    let w: Worker | null;
    try {
      w = deps.spawnWorker();
    } catch {
      return null;
    }
    if (w === null) return null;
    const onMessage = (event: MessageEvent<HighlightReply>): void => {
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;
      const id = (data as { id?: unknown }).id;
      if (typeof id !== "number") return;
      const p = pending.get(id);
      if (p === undefined) return;
      pending.delete(id);
      const html = (data as { html?: unknown }).html;
      p.resolve(typeof html === "string" ? html : null);
    };
    // A worker that errors is retired: every request it still owes is
    // answered on the main thread, and no later request goes near it. The
    // reply listener comes off first so a late message cannot resolve a
    // request twice.
    const onError = (): void => {
      if (worker !== w) return;
      worker = null;
      w.removeEventListener("message", onMessage);
      try {
        w.terminate();
      } catch {
        // Already gone.
      }
      const owed = [...pending.values()];
      pending.clear();
      for (const p of owed)
        void onMainThread(p.code, p.language).then(p.resolve);
    };
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    return w;
  };

  return {
    highlight(code, language) {
      if (worker === undefined) worker = spawn();
      const w = worker;
      if (w === null) return onMainThread(code, language);
      return new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, { code, language, resolve });
        const request: HighlightRequest = { id, code, language };
        try {
          w.postMessage(request);
        } catch {
          // The worker could not take the request (terminated between
          // calls, or the message would not clone): this one answers on
          // the main thread; the next call finds the worker as it is.
          pending.delete(id);
          void onMainThread(code, language).then(resolve);
        }
      });
    },
  };
}

let highlighterPromise: Promise<Highlighter> | null = null;
/** The main-thread highlighter, imported once — its own chunk, so a plain
 *  text file never pays for it. */
export function loadHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= import("./highlight.js");
  return highlighterPromise;
}

/** The bundled worker, or null where the platform has no `Worker` (jsdom).
 *  Vite finds the worker's entry in this exact expression and emits it as a
 *  chunk of its own; the URL resolves against the renderer bundle, which the
 *  CSP's `worker-src 'self'` admits. */
function spawnBundledWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  return new Worker(new URL("./highlight.worker.ts", import.meta.url), {
    type: "module",
  });
}

/** The one client the code view uses: a single worker per window, kept warm
 *  after its first answer (highlight.js and its languages stay loaded there
 *  instead of on the main thread). */
export const viewerHighlighter: HighlightClient = createHighlightClient({
  spawnWorker: spawnBundledWorker,
  loadHighlighter,
});
