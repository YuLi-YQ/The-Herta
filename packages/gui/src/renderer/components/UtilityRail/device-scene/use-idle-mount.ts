import { useEffect, useState } from "react";

/**
 * Gate for mounting something heavy that neither the boot nor the user's
 * first moves must wait for (ADR 0057 §2.9 / §2.10: the 3D device's
 * three.js chunk, its 3.6 MB of assets, two transcoder workers and a
 * 0.5 s synchronous first frame that freezes every main-thread animation
 * while it runs). Returns true only once ALL of these hold:
 *
 *   - `settleMs` have passed since `wanted` became true (the boot's own
 *     work is done);
 *   - `quietMs` have passed since the last pointer, key or wheel input —
 *     a click on a session starts the panel and rail transitions, and
 *     the scene must not land in the middle of them;
 *   - an idle callback fires (or its `idleTimeoutMs` deadline);
 *
 * or `maxWaitMs` have passed, so a session that is never quiet still
 * gets the scene. Falls back to a plain timer where `requestIdleCallback`
 * is missing (jsdom). Flips back to false as soon as `wanted` does.
 */
export function useIdleMount(
  wanted: boolean,
  options: Partial<IdleMountOptions> = {},
): boolean {
  const [ready, setReady] = useState(false);
  const settleMs = options.settleMs ?? IDLE_MOUNT_SETTLE_MS;
  const quietMs = options.quietMs ?? IDLE_MOUNT_QUIET_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_MOUNT_IDLE_TIMEOUT_MS;
  const maxWaitMs = options.maxWaitMs ?? IDLE_MOUNT_MAX_WAIT_MS;
  useEffect(() => {
    if (!wanted) {
      setReady(false);
      return;
    }
    return scheduleIdle(() => setReady(true), {
      settleMs,
      quietMs,
      idleTimeoutMs,
      maxWaitMs,
    });
  }, [wanted, settleMs, quietMs, idleTimeoutMs, maxWaitMs]);
  return wanted && ready;
}

export interface IdleMountOptions {
  /** Since the mount. */
  readonly settleMs: number;
  /** Since the last pointer / key / wheel input. */
  readonly quietMs: number;
  /** The idle callback's own deadline once the two waits are over. */
  readonly idleTimeoutMs: number;
  /** Quiet or not, the scene starts by this. */
  readonly maxWaitMs: number;
}

/** The boot's own work (first paint, the session list, the record) is done
 *  well inside this on the machines measured. */
export const IDLE_MOUNT_SETTLE_MS = 1500;
/** Opening a session runs a 400–1200 ms grid transition on the main
 *  thread (reference-ux.css); the stall must come after it, not during. */
export const IDLE_MOUNT_QUIET_MS = 1500;
export const IDLE_MOUNT_IDLE_TIMEOUT_MS = 3000;
export const IDLE_MOUNT_MAX_WAIT_MS = 15_000;

interface IdleWindow {
  requestIdleCallback?: (cb: () => void, opts: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
}

const INPUT_EVENTS = ["pointerdown", "keydown", "wheel"] as const;

/** Runs `fn` once, after the settle and quiet waits (capped by the max
 *  wait), in the next idle slot. Returns the cancel. */
export function scheduleIdle(
  fn: () => void,
  opts: IdleMountOptions,
): () => void {
  const w = window as unknown as IdleWindow;
  const start = Date.now();
  let lastInput = start;
  let idleId: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onInput = (): void => {
    lastInput = Date.now();
  };
  for (const name of INPUT_EVENTS) {
    window.addEventListener(name, onInput, { capture: true, passive: true });
  }
  const stopListening = (): void => {
    for (const name of INPUT_EVENTS) {
      window.removeEventListener(name, onInput, { capture: true });
    }
  };
  const arm = (): void => {
    timer = null;
    const now = Date.now();
    const readyAt = Math.min(
      Math.max(start + opts.settleMs, lastInput + opts.quietMs),
      start + opts.maxWaitMs,
    );
    if (now < readyAt) {
      timer = setTimeout(arm, readyAt - now);
      return;
    }
    stopListening();
    if (typeof w.requestIdleCallback === "function") {
      idleId = w.requestIdleCallback(fn, { timeout: opts.idleTimeoutMs });
    } else {
      fn();
    }
  };
  arm();
  return () => {
    stopListening();
    if (timer !== null) clearTimeout(timer);
    if (idleId !== null) w.cancelIdleCallback?.(idleId);
  };
}
