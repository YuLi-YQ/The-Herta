import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import { useSessionSelector } from "./useSessionSelector.js";

/**
 * Session-scoped transient state (audit 2026-07-24, Gap 1).
 *
 * THE RULE: if your transient state would be WRONG in the next session, it
 * belongs here.
 *
 * Why a primitive: `SessionStore.onReset` resets the STORE, but component-local
 * state is on its own — and the components that hold it (the utility rail, the
 * conversation, the workspace shell) are mounted for the app's lifetime, so
 * nothing unmounts them at a session boundary. Before this, four different
 * ad-hoc mechanisms coexisted — a `useEffect(..., [sessionId])`, a
 * `key={sessionId}` prop, a `<Fragment key={sessionId}>`, and (in several
 * places) nothing at all — with no rule for which to use. Every "nothing at
 * all" was a bug: the 回到底部 pill surviving a session delete, the green 完成
 * flash bleeding into the next session, the device LED's shader colour.
 *
 * "Session identity change" = switch, new session, delete-blanking
 * (sessionId → null), and open failure. Like the hand-written effects these
 * replace, the reset also runs on mount (a no-op: the state is already at its
 * initial value).
 */

/** The active session's identity, or null between sessions. */
function useSessionId(): string | null {
  return useSessionSelector((s) => s.sessionId);
}

/**
 * `useState` whose value returns to `initial` whenever the active session
 * changes. Drop-in for a `useState` + a hand-written `[sessionId]` reset
 * effect.
 *
 * ```ts
 * const [flashing, setFlashing] = useSessionScoped(false);
 * ```
 */
export function useSessionScoped<T>(
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initial);
  // The initial value is captured ONCE: a caller passing a fresh object
  // literal per render must not re-reset the state on every commit.
  const initialRef = useRef(initial);
  const sessionId = useSessionId();
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the reset trigger, not an input
  useEffect(() => {
    setValue(initialRef.current);
  }, [sessionId]);
  return [value, setValue];
}

/**
 * A ref whose `.current` returns to `initial` whenever the active session
 * changes. For the non-rendering companions of scoped state — an edge
 * baseline, a latch, a "seen it already" marker — where a stale value from
 * the previous session would fabricate a transition in the next one.
 */
export function useSessionScopedRef<T>(initial: T): { current: T } {
  const ref = useRef(initial);
  const initialRef = useRef(initial);
  const sessionId = useSessionId();
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the reset trigger, not an input
  useEffect(() => {
    ref.current = initialRef.current;
  }, [sessionId]);
  return ref;
}

export interface SessionScopedTimer {
  /** Arm (replacing any pending timer). Never fires after a session change. */
  arm(fn: () => void, ms: number): void;
  /** Cancel any pending timer. Idempotent. */
  clear(): void;
}

/**
 * A `setTimeout` that cannot outlive the session that armed it — cleared on
 * session change AND on unmount.
 *
 * This is the Class-B guard in primitive form: a timer armed for session A
 * that fires while B is open acts on the wrong session (the 1.8s success
 * flash painting the next session's device card green with a 完成 label over
 * an empty transcript).
 */
export function useSessionScopedTimer(): SessionScopedTimer {
  const handle = useRef<number | undefined>(undefined);
  const sessionId = useSessionId();
  const api = useRef<SessionScopedTimer>({
    arm(fn, ms) {
      if (handle.current !== undefined) window.clearTimeout(handle.current);
      handle.current = window.setTimeout(() => {
        handle.current = undefined;
        fn();
      }, ms);
    },
    clear() {
      if (handle.current !== undefined) {
        window.clearTimeout(handle.current);
        handle.current = undefined;
      }
    },
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the clear trigger, not an input
  useEffect(() => {
    return () => api.current.clear();
  }, [sessionId]);
  return api.current;
}

/**
 * Run `fn` when the active session changes (and once on mount). The escape
 * hatch for resets the typed primitives above don't cover — imperative DOM
 * cleanup, cancelling a non-timeout async watcher.
 *
 * Prefer `useSessionScoped` / `useSessionScopedRef` / `useSessionScopedTimer`
 * where they fit: they state the intent in the declaration instead of in a
 * side effect.
 */
export function useOnSessionChange(fn: () => void): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const sessionId = useSessionId();
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger; fn rides a ref so a fresh closure doesn't re-fire it
  useEffect(() => {
    fnRef.current();
  }, [sessionId]);
}
