/**
 * Instrumentation for the streaming reveal path (perf 2026-08-25).
 *
 * The live bubble re-derives display state per rAF frame while a reply
 * streams; before the incremental caches landed, that work was O(full
 * reply) per frame (O(n²) per reply) and there was no way to SEE it.
 * These spans make the reveal-path cost observable in two units:
 *   - `chars` — characters actually examined by the span (scan work, the
 *     machine-independent metric the perf harness compares before/after);
 *   - `ms` — wall time, mirrored into `performance.measure` entries
 *     (`herta:<span>`) so a DevTools Performance recording shows them.
 *
 * OFF by default: the only cost on the hot path is one boolean check.
 * Enable from DevTools via `window.__hertaRevealPerf.enable(true)`, or
 * from tests via `setRevealPerfEnabled` — the reveal perf harness
 * (`reveal-path.perf.test.tsx`) is the standing consumer.
 */

export interface RevealSpanTotals {
  calls: number;
  /** Characters examined across all calls (input sizes, not output). */
  chars: number;
  /** Wall-clock milliseconds across all calls. */
  ms: number;
}

let enabled = false;
const totals = new Map<string, RevealSpanTotals>();

export function setRevealPerfEnabled(on: boolean): void {
  enabled = on;
}

export function isRevealPerfEnabled(): boolean {
  return enabled;
}

export function resetRevealPerf(): void {
  totals.clear();
}

/** Copy of the accumulated span totals (name → totals). */
export function snapshotRevealPerf(): Record<string, RevealSpanTotals> {
  const out: Record<string, RevealSpanTotals> = {};
  for (const [name, t] of totals) out[name] = { ...t };
  return out;
}

/**
 * Run `work` under a named span. When disabled this is a plain call —
 * no timing, no allocation beyond the closures the call site already
 * built. `chars` reports the scan work of THIS call (given the result,
 * so incremental derivations can report how much they actually
 * examined, not their full input length).
 */
export function measureRevealSpan<T>(
  name: string,
  work: () => T,
  chars: (result: T) => number,
): T {
  if (!enabled) return work();
  const t0 = performance.now();
  const result = work();
  const t1 = performance.now();
  const t = totals.get(name) ?? { calls: 0, chars: 0, ms: 0 };
  t.calls += 1;
  t.chars += chars(result);
  t.ms += t1 - t0;
  totals.set(name, t);
  try {
    // User Timing entry for DevTools timeline recordings. jsdom lacks the
    // options form of measure — totals above are the source of truth.
    performance.measure(`herta:${name}`, { start: t0, end: t1 });
  } catch {
    // No-op where User Timing L3 is unavailable.
  }
  return result;
}

// DevTools handle for live sessions: enable, stream, snapshot. A plain
// property on window — display-only diagnostics (D7), never read by the
// app itself.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__hertaRevealPerf = {
    enable: setRevealPerfEnabled,
    snapshot: snapshotRevealPerf,
    reset: resetRevealPerf,
  };
}
