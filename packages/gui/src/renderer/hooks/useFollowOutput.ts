import {
  type MutableRefObject,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/** Keys that scroll a focused or last-clicked scroller. */
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);
/** How long after a wheel, key, or touch a scroll still counts as the reader's own. */
const INPUT_WINDOW_MS = 400;

/**
 * Keep a live transcript on its newest line while the reader is there (R44).
 *
 * The old rule re-derived "following" from the distance to the bottom on every
 * scroll event. A wheel notch, a single ↑ or a slow touchpad drag spends its
 * first frames inside that distance, so the next streamed chunk (or the chat's
 * 400 ms poll) pulled the reader straight back down. Here an upward scroll the
 * reader caused — wheel, keyboard, touch, or dragging the scrollbar — lets go
 * at once; only reaching the bottom again, or 回到最新, re-arms it. Upward
 * movement with no input behind it (content above shrinking, scroll
 * anchoring) is layout, not the reader, and never lets go. While following, a
 * resize of the viewport keeps the newest line in view.
 */
export function useFollowOutput(
  ref: RefObject<HTMLElement>,
  threshold: number,
): {
  /** Read by the owner's content effects: scroll to the end only while true. */
  readonly following: MutableRefObject<boolean>;
  /** The reader has left the newest line; offer 回到最新. */
  readonly away: boolean;
  /** Pin to the newest line if still following (after content changes). */
  readonly stick: () => void;
  /** Re-arm and jump to the newest line (回到最新, a new session or chat). */
  readonly jump: () => void;
} {
  const following = useRef(true);
  const leaving = useRef(false);
  const [away, setAway] = useState(false);
  const stick = useCallback(() => {
    const el = ref.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [ref]);
  const jump = useCallback(() => {
    leaving.current = false;
    following.current = true;
    setAway(false);
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ref]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the scroller is mounted for the owner's lifetime; listeners read live values.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let lastTop = el.scrollTop;
    let lastHeight = el.scrollHeight;
    let lastSize = `${el.clientWidth}x${el.clientHeight}`;
    let inputAt = Number.NEGATIVE_INFINITY;
    let pressed = false;
    let touchY: number | null = null;
    const release = (): void => {
      leaving.current = true;
      following.current = false;
      setAway(true);
    };
    /** Input starts a gesture: later scroll events are judged from here. */
    const mark = (): void => {
      inputAt = performance.now();
      lastTop = el.scrollTop;
      lastHeight = el.scrollHeight;
    };
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey || e.deltaY === 0) return; // Ctrl+wheel zooms
      mark();
      if (e.deltaY > 0) leaving.current = false;
      else if (el.scrollTop > 0) release();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (SCROLL_KEYS.has(e.key)) mark();
    };
    const onPointerDown = (): void => {
      pressed = true;
      mark();
    };
    const onPointerUp = (): void => {
      pressed = false;
    };
    const onTouchStart = (e: TouchEvent): void => {
      touchY = e.touches[0]?.clientY ?? null;
      mark();
    };
    const onTouchMove = (e: TouchEvent): void => {
      const y = e.touches[0]?.clientY;
      inputAt = performance.now();
      if (touchY === null || y === undefined) return;
      // A finger moving down drags older content into view.
      if (y > touchY + 4 && el.scrollTop > 0) release();
      else if (y < touchY - 4) leaving.current = false;
      touchY = y;
    };
    const onScroll = (): void => {
      const top = el.scrollTop;
      const height = el.scrollHeight;
      const byReader = pressed || performance.now() - inputAt < INPUT_WINDOW_MS;
      // The viewport itself changed size (a window resize reflows the text):
      // Chromium's scroll anchoring reports that as a scroll before the
      // ResizeObserver below runs. Layout, not the reader — stay pinned (R56).
      const size = `${el.clientWidth}x${el.clientHeight}`;
      const resized = size !== lastSize;
      lastSize = size;
      if (resized && following.current && !byReader) {
        el.scrollTop = el.scrollHeight;
        lastTop = el.scrollTop;
        lastHeight = height;
        return;
      }
      if (byReader && top < lastTop - 1 && height >= lastHeight) release();
      else if (byReader && top > lastTop + 1) leaving.current = false;
      lastTop = top;
      lastHeight = height;
      if (height - el.clientHeight - top <= threshold) {
        if (!leaving.current) {
          following.current = true;
          setAway(false);
        }
      } else {
        following.current = false;
        setAway(true);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    window.addEventListener("blur", onPointerUp);
    const resized =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (following.current) el.scrollTop = el.scrollHeight;
          });
    resized?.observe(el);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      window.removeEventListener("blur", onPointerUp);
      resized?.disconnect();
    };
  }, []);
  return { following, away, stick, jump };
}
