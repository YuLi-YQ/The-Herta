import { useEffect, useRef, useState } from "react";

/** The magnitude of one patch, or the honest absence of one. */
export type DiffStatValue =
  | { readonly add: number; readonly del: number }
  /** The change reached the tree through a COMMAND (`sed -i`, a heredoc, an
   *  `mv`), so no per-file diff exists. Never rendered as `+0 −0`. */
  | "unmeasured";

/** How long the digits take to reach their value. Long enough to read as
 *  accumulation, short enough that a row is never stale when the eye lands. */
const COUNT_MS = 460;

/** How old a block can be and still count as a LIVE append. Same window as
 *  the live-attach entrance gate in ActivityBlock: a live projection is
 *  seconds old, a session switch or reload mounts blocks that are not. */
const LIVE_MS = 5000;

/**
 * Whether a block's `at` stamp reads as a live append, decided from the
 * stamp alone — no store flag ("animate the next marker"), which is the
 * cross-component transient state the 2026-07-24 audit catalogued. Absent
 * stamps (pre-timestamp records) are history by definition.
 */
function isLiveStamp(at: string | undefined): boolean {
  if (at === undefined) return false;
  const age = Date.now() - Date.parse(at);
  return Number.isFinite(age) && age >= 0 && LIVE_MS > age;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Count from 0 to `target` once, on mount.
 *
 * The point is not decoration: a write's magnitude is the one thing the row
 * exists to say, and a number that ARRIVES draws the eye to itself in a
 * record where every other row is static text. Under reduced motion, when the
 * row is history rather than a live append (`animate` false), and in any
 * environment without rAF (jsdom), it returns the target immediately — the
 * row is then simply correct rather than animated.
 */
export function useCountUp(target: number, animate: boolean): number {
  const [value, setValue] = useState(() =>
    !animate || prefersReducedMotion() ? target : 0,
  );
  const frame = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (
      !animate ||
      prefersReducedMotion() ||
      typeof requestAnimationFrame !== "function"
    ) {
      setValue(target);
      return;
    }
    if (target === 0) {
      setValue(0);
      return;
    }
    // The origin is the FIRST FRAME's own timestamp, not `performance.now()`.
    // The two need not share a time origin — under jsdom they do not, and the
    // resulting negative elapsed time went through the cubic below as a large
    // NEGATIVE count (`+-28355`). Clamped as well, so no clock can produce a
    // number outside 0…target.
    let started: number | undefined;
    const tick = (now: number): void => {
      started ??= now;
      const p = Math.min(1, Math.max(0, (now - started) / COUNT_MS));
      // Decelerating, so the last digits settle rather than snap.
      const eased = 1 - (1 - p) ** 3;
      setValue(Math.round(target * eased));
      if (p < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    // A frame loop that never runs would leave the row reading `+0 −0` — a
    // number nobody measured, which is the whole failure this row exists to
    // avoid. rAF is throttled to nothing in a background tab and is a
    // non-firing shim in some test environments, so the settled value is
    // guaranteed here rather than left to the animation.
    const settle = setTimeout(() => setValue(target), COUNT_MS + 120);
    return () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      clearTimeout(settle);
    };
  }, [target, animate]);

  return value;
}

export interface DiffStatProps {
  readonly value: DiffStatValue;
  /** Larger, slightly stronger treatment for the done-marker roll-up. */
  readonly rollup?: boolean;
  /**
   * The block's own `at` stamp. Decides ONCE at mount whether the digits
   * count up and the row plays its entrance: a live append is seconds old, a
   * session switch or reload mounts blocks that are not — so history never
   * replays the entrance (the live-attach gate's rule, applied here). Absent
   * on pre-timestamp records, which therefore render settled.
   */
  readonly at?: string;
}

/**
 * `+96 −5` — the magnitude of a write, as the `↳` outcome row every other
 * operation already has (`↳ 5 处匹配 · 1 个文件`, `↳ 测试: 3 passed`).
 *
 * A write was the ONE operation whose row said nothing about its own size:
 * the patch block's headline read `patch preview: <files>`, which only
 * restates the `Writing` row above it.
 *
 * Unmeasured renders NOTHING (owner, 2026-08-25 evening — the first version
 * spelled it out as `已改动（命令，无逐行差异）`, which is a sentence about the
 * absence of a number, on a row that already names the file it changed). The
 * honest-unknown rule is unchanged: silence, never a `+0 −0` nobody measured.
 */
export function DiffStat(props: DiffStatProps): JSX.Element | null {
  // Decided once at mount, off the stamp alone — a re-render mid-animation
  // (a sibling row appending) must not flip a live row back to settled.
  const [live] = useState(() => isLiveStamp(props.at));
  if (props.value === "unmeasured") return null;
  return (
    <span
      className={`diff-stat${live ? " diff-stat--live" : ""}${
        props.rollup === true ? " diff-stat--rollup" : ""
      }`}
    >
      <DiffStatNumber kind="add" target={props.value.add} animate={live} />
      <DiffStatNumber kind="del" target={props.value.del} animate={live} />
    </span>
  );
}

function DiffStatNumber(props: {
  kind: "add" | "del";
  target: number;
  animate: boolean;
}): JSX.Element {
  const n = useCountUp(props.target, props.animate);
  return (
    <span className={`diff-stat__n diff-stat__n--${props.kind}`}>
      {props.kind === "add" ? "+" : "−"}
      {n}
    </span>
  );
}
