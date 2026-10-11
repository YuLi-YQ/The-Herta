/** Crashes remembered for the loop guard. */
export const CRASH_WINDOW_MS = 60_000;
/** Reloads allowed inside one window before the guard gives up. */
export const MAX_RELOADS_PER_WINDOW = 3;

/**
 * Whether a renderer that just went away should be reloaded.
 *
 * Nothing handled `render-process-gone`: a renderer that crashed — a GPU
 * driver reset under the 3D card, an out-of-memory — left a dead window
 * until the app was restarted (UX review 2026-09-22, item 7). Reloading it
 * is enough: the page's `did-finish-load` re-enters the session service,
 * whose snapshot re-syncs the session, the turn state included.
 *
 * A clean exit is not a crash, and a quit in progress wants the window
 * gone. And the reload is bounded: a renderer that dies again and again
 * inside a minute stops being reloaded, because a crash loop would spin
 * the GPU process and never show the user anything. `history` is the
 * caller's list of recent crash times; this function prunes and appends.
 */
export function shouldReloadAfterCrash(opts: {
  readonly reason: string;
  readonly quitting: boolean;
  readonly history: number[];
  readonly now: number;
}): boolean {
  if (opts.reason === "clean-exit" || opts.quitting) return false;
  const { history, now } = opts;
  while (history.length > 0 && now - (history[0] ?? now) > CRASH_WINDOW_MS) {
    history.shift();
  }
  history.push(now);
  return history.length <= MAX_RELOADS_PER_WINDOW;
}
