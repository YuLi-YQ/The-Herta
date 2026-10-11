import {
  type CSSProperties,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { computeDragResult, pointOverDevice } from "./dragTracker.js";

export interface UseDragToLiftOpts {
  readonly threshold?: number;
  readonly liftProbability?: number;
  readonly maxLiftPx?: number;
  /** Voice-line trigger on successful lift. Slice 3: no-op. */
  readonly onSuccessfulLift?: () => void;
}

export interface UseDragToLiftResult {
  readonly onMouseDown: (e: MouseEvent<HTMLElement>) => void;
  readonly transform: string | null;
  readonly shadowStyle: CSSProperties | undefined;
  /** The current lift in CSS px, 0 when not lifting — what the 3D card
   *  springs toward (ADR 0057). */
  readonly liftPx: number;
}

const DEFAULT_THRESHOLD = 8;
const DEFAULT_LIFT_PROBABILITY = 0.3;
const DEFAULT_MAX_LIFT_PX = 12;

export function useDragToLift(
  opts: UseDragToLiftOpts = {},
): UseDragToLiftResult {
  const reducedMotion = useReducedMotion();
  const [transform, setTransform] = useState<string | null>(null);
  const [shadowStyle, setShadowStyle] = useState<CSSProperties | undefined>(
    undefined,
  );
  const [liftPx, setLiftPx] = useState(0);

  const startY = useRef<number | null>(null);
  const chance = useRef<number>(0);
  const triggered = useRef<boolean>(false);

  // Latest-ref pattern: the window listeners (below) are created ONCE and
  // are stable for the hook's lifetime, so addEventListener and
  // removeEventListener always reference the same function identity — a
  // mid-drag re-render can never desync them and leak a listener. The
  // listeners read current opts / reducedMotion through these refs rather
  // than via closure capture, so behavior still tracks the latest props.
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  // Stable handler pair, lazily created once.
  const handlersRef = useRef<{
    readonly move: (e: globalThis.MouseEvent) => void;
    readonly up: () => void;
  } | null>(null);

  if (handlersRef.current === null) {
    const move = (e: globalThis.MouseEvent): void => {
      if (startY.current === null) return;
      const o = optsRef.current;
      const result = computeDragResult({
        dragDeltaY: e.clientY - startY.current,
        chance: chance.current,
        threshold: o.threshold ?? DEFAULT_THRESHOLD,
        liftProbability: o.liftProbability ?? DEFAULT_LIFT_PROBABILITY,
        maxLiftPx: o.maxLiftPx ?? DEFAULT_MAX_LIFT_PX,
        reducedMotion: reducedMotionRef.current,
      });
      setTransform(result.transform);
      setShadowStyle(result.shadowStyle);
      setLiftPx(result.liftPx);
      if (result.transform !== null && !triggered.current) {
        triggered.current = true;
        o.onSuccessfulLift?.();
      }
    };
    const up = (): void => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      // Settle-back is CSS-driven (transition on transform); clearing the
      // inline transform here hands control to the CSS ease-out.
      startY.current = null;
      triggered.current = false;
      setTransform(null);
      setShadowStyle(undefined);
      setLiftPx(0);
    };
    handlersRef.current = { move, up };
  }

  // Unmount cleanup (audit 2026-07-10 §6): a card unmounting MID-DRAG left
  // the window mousemove/mouseup listeners attached — self-healing only at
  // the next global mouseup, whose handler then set state on an unmounted
  // component. Removing an unattached listener is a no-op, so this is safe
  // whether or not a drag was in flight.
  useEffect(
    () => () => {
      const handlers = handlersRef.current;
      if (handlers !== null) {
        window.removeEventListener("mousemove", handlers.move);
        window.removeEventListener("mouseup", handlers.up);
      }
    },
    [],
  );

  const onMouseDown = useCallback((e: MouseEvent<HTMLElement>): void => {
    if (reducedMotionRef.current) return;
    const handlers = handlersRef.current;
    if (handlers === null) return;
    // Only a press ON the device starts a lift: the preview box is wider
    // and taller than the silhouette. A box without size (jsdom) cannot be
    // tested against and is let through.
    const box = e.currentTarget.getBoundingClientRect();
    if (
      box.width > 0 &&
      box.height > 0 &&
      !pointOverDevice(
        (e.clientX - box.left) / box.width,
        (e.clientY - box.top) / box.height,
      )
    ) {
      return;
    }
    startY.current = e.clientY;
    chance.current = Math.random();
    triggered.current = false;
    window.addEventListener("mousemove", handlers.move);
    window.addEventListener("mouseup", handlers.up);
  }, []);

  return { onMouseDown, transform, shadowStyle, liftPx };
}
