import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useWorkspaceRefs } from "./WorkspaceRefs.js";

/** Cross-fade duration at hand-off: the landed clone fades out (carrying its
 *  drop-shadow) while the real send button fades in beneath it, instead of an
 *  instant swap. */
const REVEAL_MS = 260;
const SHRINK_MS = 600;
/** Slide duration when a mid-morph window resize retargets the anchor to the
 *  send button's new resting spot — short, so the clone catches up quickly. */
const RETARGET_MS = 250;
/** Last-resort escape while the arrival watch runs (audit 2026-07-24, M9).
 *  Comfortably longer than the watch's own 240-frame (~4s) bound, so it only
 *  fires when the watch itself died — e.g. `disconnected` flipping true
 *  mid-hand-off, which otherwise wedged the workspace with neither the
 *  connect button nor the composer. */
const WATCH_GUARD_MS = 6000;
/** Base duration of the curved travel (the former 320ms right + 380ms down
 *  segments, now ONE swoop — see the offset-path keyframes below). */
const TRAVEL_MS = 700;
/** The swoop's path length the base duration was tuned against (~the curve
 *  through the old corner at a ~1440-wide window). On larger windows the
 *  same duration over a much longer path made the circle hop several times
 *  its own diameter per frame — reading as dropped frames at a perfect
 *  60fps (user 2026-07-13, fullscreen). The travel stretches by
 *  sqrt(length/reference), capped at 2×, so peak velocity stays near the
 *  designed feel without the morph ever dragging past ~2s. */
const TRAVEL_REF_PX = 700;
const TARGET = 38;
const COLOR_START = 0.7;
/** Fallback start color when the computed style is unreadable (jsdom).
 *  The REAL start color is read off the clone at animation time — its CSS
 *  background is var(--ink), which the dark theme flips to a light pill;
 *  hardcoding the light theme's #111417 here forced the button BLACK for
 *  the whole descent in dark mode (user bug 2026-07-13). */
const DARK = "#111417";
/** The landing color — matches .composer-send:disabled, which keeps this
 *  muted slate in BOTH themes. */
const GRAY = "rgba(154,160,181,0.55)";
const E_SHRINK = "cubic-bezier(0.4,0,0.2,1)";
/** One easing for the whole swoop (the house signature curve). The old
 *  two-segment travel used an overshoot bezier for the rightward pop, then
 *  came to a FULL STOP at the 90° corner before accelerating down — the
 *  curved path replaces both with one continuous velocity profile. */
const E_SWOOP = "cubic-bezier(0.2,0.85,0.2,1)";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The anchor frame's inline geometry: the FINAL (connected) send button's
 *  footprint as overlay-relative left/top. The overlay's left/top edges are
 *  constant through the connect (only its right narrows with the rail), so a
 *  left/top-placed frame is screen-STABLE at the final button spot. */
interface AnchorBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Pt {
  readonly x: number;
  readonly y: number;
}

/** Arc length of the quadratic Bézier p0→(ctrl p1)→p2, sampled — plenty for
 *  duration scaling and offset-distance keyframe values. */
function quadLength(p0: Pt, p1: Pt, p2: Pt): number {
  const STEPS = 16;
  let len = 0;
  let px = p0.x;
  let py = p0.y;
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    const mt = 1 - t;
    const x = mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x;
    const y = mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y;
    len += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  return len;
}

const fmt = (n: number): string => n.toFixed(2);

/**
 * Measure the send button's FINAL (connected) rect plus the overlay rect, with
 * the rail/grid transitions SUPPRESSED. `.workspace-body` transitions
 * grid-template-columns; once that property is armed (a prior connect/disconnect
 * transitioned it), synchronously toggling `.is-disconnected` and reading would
 * return the transition's START value — the WIDE send x — so the flight aimed
 * ~362px right and the circle landed off-target on the 2nd+ connect (user
 * 2026-07-15). Suppressing the transition (transition:none + forced reflow)
 * resolves the class swap to the true FINAL computed value every time. The
 * composer is content-visibility:hidden while disconnected (a skipped subtree's
 * geometry is stale on packaged first launch), so it is un-skipped for the read.
 * Every mutation is reverted in the SAME synchronous task — no paint between, so
 * no transition fires and nothing flashes. Callers derive the overlay-relative
 * anchor box (sb − ov) and, at begin(), the connect-button start offset.
 */
function measureFinalSendBox(
  overlay: HTMLElement,
  send: HTMLElement,
): { sb: Rect; ov: Rect } {
  const ov = overlay.getBoundingClientRect();
  const app = overlay.closest(".app") as HTMLElement | null;
  const composerEl = send.closest(".composer") as HTMLElement | null;
  // `?? null` — optional chaining yields undefined when app is null, which
  // would slip past the `!== null` guards below and deref undefined.style.
  const body = (app?.querySelector(".workspace-body") ??
    null) as HTMLElement | null;
  const rail = (app?.querySelector(".utility-rail") ??
    null) as HTMLElement | null;
  // `.workspace` transitions margin-right since ADR 0050 (the old grid gap
  // moved onto it) — an ARMED margin transition makes the suppressed read
  // return its start value (0 while disconnected), which measured the send
  // spot 24px right of true and landed the circle on the composer's edge
  // (owner 2026-08-31). Same suppression as the grid/rail.
  const wsEl = (app?.querySelector(".workspace") ?? null) as HTMLElement | null;
  const wasDisc = app?.classList.contains("is-disconnected") ?? false;
  const bodyTr = body?.style.transition ?? "";
  const railTr = rail?.style.transition ?? "";
  const wsTr = wsEl?.style.transition ?? "";
  if (body !== null) body.style.transition = "none";
  if (rail !== null) rail.style.transition = "none";
  if (wsEl !== null) wsEl.style.transition = "none";
  if (wasDisc) app?.classList.remove("is-disconnected");
  // Force the un-collapsed grid to lay out with transitions off (so the read
  // below sees the settled narrow columns, not a transition start).
  if (body !== null) void body.offsetWidth;
  composerEl?.style.setProperty("content-visibility", "visible");
  const r = send.getBoundingClientRect();
  composerEl?.style.removeProperty("content-visibility");
  if (wasDisc) app?.classList.add("is-disconnected");
  // Commit the snap back to wide BEFORE re-enabling transitions, so restoring
  // them cannot animate the revert.
  if (body !== null) void body.offsetWidth;
  if (body !== null) body.style.transition = bodyTr;
  if (rail !== null) rail.style.transition = railTr;
  if (wsEl !== null) wsEl.style.transition = wsTr;
  return {
    sb: { left: r.left, top: r.top, width: r.width, height: r.height },
    ov: { left: ov.left, top: ov.top, width: ov.width, height: ov.height },
  };
}

export interface ReconnectMorph {
  readonly reconnecting: boolean;
  /** True during the hand-off cross-fade (clone fading out, send fading in). */
  readonly revealing: boolean;
  /** The frame the clone flies INSIDE, pinned by overlay-relative left/top at
   *  the FINAL (connected) send-button spot. The overlay's left/top edges are
   *  constant through the connect, so the frame is screen-stable there for the
   *  whole flight and wait — the flight aims at a fixed target and arcs to it. */
  readonly anchorRef: React.RefObject<HTMLDivElement>;
  readonly cloneRef: React.RefObject<HTMLDivElement>;
  begin(buttonRect: DOMRect): void;
  cancel(): void;
}

/**
 * The connect→send reconnect morph. Coordinate system (user traces
 * 2026-07-15): on connect the workspace NARROWS by the utility rail
 * (~362px, right edge only) over an 800ms transition once the session
 * loads — so the send button slides left on a timeline that races the
 * ~1.3s flight. The earlier scheme flew inside a right/bottom-INSET frame
 * that rode this narrowing, plus a blend to keep the take-off screen-stable;
 * but the flight ran longer than the narrowing, so the ride and blend never
 * lined up: the circle shrank ~220px LEFT of the target, then landed RIGHT
 * of it and slid left. The fix aims the flight at the FINAL send position,
 * measured once at begin() by momentarily applying the connected layout
 * (the exact settle pixel, CDP-verified), and pins the frame there by
 * overlay-relative LEFT/TOP (the overlay's left/top hold constant while its
 * right narrows). The frame is then screen-stable: the circle shrinks in
 * place and arcs straight to the fixed target — no riding, no blend, no
 * chase. The reveal watch still waits for the real button to rise/narrow
 * into the frame before handing off.
 */
export function useReconnectMorph(args: {
  readonly disconnected: boolean;
  readonly reduced: boolean;
}): ReconnectMorph {
  const { disconnected, reduced } = args;
  const { overlayRef, sendButtonRef } = useWorkspaceRefs();
  const anchorRef = useRef<HTMLDivElement>(null);
  const cloneRef = useRef<HTMLDivElement>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [landed, setLanded] = useState(false);
  const [revealing, setRevealing] = useState(false);
  /** Flight start rect (the connect button), ANCHOR-relative. */
  const start = useRef<Rect | null>(null);
  /** The anchor frame's inline geometry, applied when the portal mounts. */
  const anchorBox = useRef<AnchorBox | null>(null);
  const landTimer = useRef<number | null>(null);
  const guardTimer = useRef<number | null>(null);
  const revealTimer = useRef<number | null>(null);
  // rAF handle for the hand-off's arrival watch (below). Held in a ref so
  // cancel()/cleanup can stop a watch in flight.
  const holdFrame = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (landTimer.current !== null) window.clearTimeout(landTimer.current);
    if (guardTimer.current !== null) window.clearTimeout(guardTimer.current);
    if (revealTimer.current !== null) window.clearTimeout(revealTimer.current);
    if (holdFrame.current !== null) cancelAnimationFrame(holdFrame.current);
    landTimer.current = null;
    guardTimer.current = null;
    revealTimer.current = null;
    holdFrame.current = null;
  }, []);

  const cancel = useCallback(() => {
    clearTimers();
    start.current = null;
    anchorBox.current = null;
    setLanded(false);
    setRevealing(false);
    setReconnecting(false);
  }, [clearTimers]);

  // Phase 2 of the hand-off: unmount the clone and reset.
  const completeReveal = useCallback((): void => {
    revealTimer.current = null;
    start.current = null;
    anchorBox.current = null;
    setLanded(false);
    setRevealing(false);
    setReconnecting(false);
  }, []);

  const begin = useCallback(
    (buttonRect: DOMRect) => {
      if (reduced) return;
      // Re-entrancy guard (audit T3.7 latent): a second begin() while a
      // flight is up would overwrite start/anchorBox under the running
      // animations WITHOUT re-running the flight effect (its `reconnecting`
      // dep doesn't change) — mixed-geometry flight. The ConnectStation's
      // click latch already makes this unreachable on the normal path;
      // enforce it at the hook boundary too.
      if (reconnecting) return;
      const overlay = overlayRef.current;
      const send = sendButtonRef.current;
      if (overlay === null || send === null) return;
      // Measure the FINAL (connected) send spot with the rail/grid transitions
      // suppressed (measureFinalSendBox — this is what fixes the 2nd-connect
      // drift). The anchor frame = that footprint as overlay-relative left/top;
      // the overlay's left/top hold constant through the connect (only its right
      // narrows), so the frame is screen-stable at the final button spot and the
      // flight arcs to a fixed point — no riding, no blend, no chase. The one
      // thing that moves it is a mid-morph WINDOW resize; the resize effect below
      // re-measures and slides the anchor to the new spot.
      const { sb, ov } = measureFinalSendBox(overlay, send);
      anchorBox.current = {
        left: sb.left - ov.left,
        top: sb.top - ov.top,
        width: sb.width,
        height: sb.height,
      };
      // Flight start (the connect button), relative to the FINAL send so the
      // whole path lives in the fixed frame's coordinate space.
      start.current = {
        left: buttonRect.left - sb.left,
        top: buttonRect.top - sb.top,
        width: buttonRect.width,
        height: buttonRect.height,
      };
      setLanded(false);
      setReconnecting(true);
    },
    [reduced, reconnecting, overlayRef, sendButtonRef],
  );

  useLayoutEffect(() => {
    if (!reconnecting) return;
    const anchor = anchorRef.current;
    const el = cloneRef.current;
    const s = start.current;
    const box = anchorBox.current;
    if (anchor === null || el === null || s === null || box === null) return;
    // Place the anchor frame at the FINAL send spot (overlay-relative
    // left/top). Inline because it is measured; the class supplies
    // position:absolute (see .reconnect-morph-anchor).
    anchor.style.left = `${fmt(box.left)}px`;
    anchor.style.top = `${fmt(box.top)}px`;
    anchor.style.width = `${fmt(box.width)}px`;
    anchor.style.height = `${fmt(box.height)}px`;
    const label = el.querySelector(
      ".reconnect-morph-clone-label",
    ) as HTMLElement | null;
    const arrow = el.querySelector(
      ".reconnect-morph-clone-arrow",
    ) as HTMLElement | null;
    const circleTop = s.top + (s.height - TARGET) / 2;
    const rightAnchorLeft = s.left + s.width - TARGET;
    // Velocity-aware phase durations (fullscreen judder, 2026-07-13): the
    // right/down travels stretch with the actual path length so the circle
    // never hops several diameters per frame on a large window. The tests'
    // small mock geometry stays at the reference 1300ms total.
    const stretch = (d: number, ref: number): number =>
      Math.min(2, Math.max(1, Math.sqrt(d / ref)));
    // The flight path, in element-CENTER coordinates (offset-anchor is the
    // box center, so the path holds the visual center steady through the
    // size morph), ANCHOR-relative — the landing center is simply the
    // frame's own center:
    //   M pill center  →L  circle-at-right-edge center   (the shrink leg)
    //   →Q gentle right-and-down arc  →  frame center    (the swoop)
    // The control point sits BETWEEN the endpoints (biased toward the
    // right-then-down corner), so BOTH axes progress monotonically across
    // the whole swoop. That property is load-bearing under the riding
    // frame (two user traces, 2026-07-14): a control point AT the frame's
    // column parked the circle at the target X early — while the frame
    // still mapped to the WIDE layout, the trajectory swung out through
    // the incoming utility-card area; the down-first variant parked at the
    // LAUNCH column instead and read as a drifting descent plus a slide
    // along the composer. A between-lerp control point spreads the
    // horizontal travel over the full swoop: the circle only reaches the
    // send column at the END, when the frame has settled — one smooth arc
    // in every layout mapping.
    const c0: Pt = { x: s.left + s.width / 2, y: s.top + s.height / 2 };
    const c1: Pt = {
      x: rightAnchorLeft + TARGET / 2,
      y: circleTop + TARGET / 2,
    };
    const c2: Pt = { x: box.width / 2, y: box.height / 2 };
    const corner: Pt = {
      x: c1.x + 0.6 * (c2.x - c1.x),
      y: c1.y + 0.22 * (c2.y - c1.y),
    };
    const shrinkLen = Math.hypot(c1.x - c0.x, c1.y - c0.y);
    const swoopLen = quadLength(c1, corner, c2);
    const travelMs = TRAVEL_MS * stretch(swoopLen, TRAVEL_REF_PX);
    const totalMs = SHRINK_MS + travelMs;
    // o1: where the shrink leg ends and the swoop begins.
    const o1 = SHRINK_MS / totalMs;
    // These WAAPI animations are intentionally NOT tracked/cancelled (unlike
    // useConnectMorph's flight handle): fill:"forwards" keeps the final frame
    // and they are garbage-collected with the clone element on hand-off/cancel.
    if (typeof el.animate === "function") {
      // The clone's base position is STATIC (the CSS left/top 0 inside the
      // anchor); ALL movement rides offset-distance along the path, which
      // stays on the COMPOSITOR — session-open work janks the main thread
      // exactly during this window, and a main-thread animation visibly
      // skipped with it (2026-07-13). Kept separate from the width/height
      // animation below: mixing layout properties in would demote the
      // effect off the compositor. offset-rotate must be zeroed or the pill
      // would turn to face the path direction.
      el.style.offsetPath = `path("M ${fmt(c0.x)} ${fmt(c0.y)} L ${fmt(c1.x)} ${fmt(c1.y)} Q ${fmt(corner.x)} ${fmt(corner.y)} ${fmt(c2.x)} ${fmt(c2.y)}")`;
      el.style.offsetRotate = "0deg";
      el.style.offsetAnchor = "50% 50%";
      el.animate(
        [
          { offset: 0, offsetDistance: "0px", easing: E_SHRINK },
          {
            offset: o1,
            offsetDistance: `${fmt(shrinkLen)}px`,
            easing: E_SWOOP,
          },
          { offset: 1, offsetDistance: `${fmt(shrinkLen + swoopLen)}px` },
        ],
        { duration: totalMs, fill: "forwards" },
      );
      // Velocity stretch (anti-strobing, 2026-07-13): at peak travel speed
      // the empty circle still steps ~2 diameters per frame at 60Hz — a
      // subtle elongation along the motion direction fakes the missing
      // motion blur. Axis-aligned squash keyframes matched to the swoop's
      // velocity profile — the swoop now launches DOWNWARD (Y-stretch on
      // the fast-out peak) and tucks RIGHT at the tail (milder X-stretch),
      // with the corner's diagonal tangent at neutral scale (axis-aligned
      // can't express 45°, and 1.0 is least wrong), all settled well
      // before landing. Safe because the circle carries nothing here: the
      // label is gone by mid-shrink and the arrow only fades in from 60%
      // of the swoop (below), when the stretch is already decaying. This
      // is the clone's ONLY transform animation (movement rides
      // offset-distance), so it composites cleanly alongside the flight.
      const sw = (f: number): number => o1 + (1 - o1) * f;
      el.animate(
        [
          { offset: 0, transform: "scale(1, 1)" },
          { offset: o1, transform: "scale(1, 1)", easing: "ease-out" },
          {
            offset: sw(0.12),
            transform: "scale(0.95, 1.16)",
            easing: "ease-in-out",
          },
          {
            offset: sw(0.45),
            transform: "scale(1.02, 1.02)",
            easing: "ease-in-out",
          },
          {
            offset: sw(0.62),
            transform: "scale(1.1, 0.97)",
            easing: "ease-out",
          },
          { offset: sw(0.85), transform: "scale(1, 1)" },
          { offset: 1, transform: "scale(1, 1)" },
        ],
        { duration: totalMs, fill: "forwards" },
      );
      // Size + radius (layout/paint — main thread, but they settle at o1 and
      // the shrink happens in place, so a mid-shrink main-thread hiccup at
      // worst holds the size for a frame; the ride itself stays composited.
      el.animate(
        [
          {
            offset: 0,
            width: `${s.width}px`,
            height: `${s.height}px`,
            borderRadius: "28px",
            easing: E_SHRINK,
          },
          {
            offset: o1,
            width: `${TARGET}px`,
            height: `${TARGET}px`,
            borderRadius: "19px",
          },
          {
            offset: 1,
            width: `${TARGET}px`,
            height: `${TARGET}px`,
            borderRadius: "19px",
          },
        ],
        { duration: totalMs, fill: "forwards" },
      );
      // Start from the clone's THEMED background (CSS var(--ink) — a dark
      // pill in light mode, a light one in dark mode) so the WAAPI override
      // never snaps the button to the wrong theme's color mid-flight.
      const startBg = getComputedStyle(el).backgroundColor || DARK;
      el.animate(
        [
          { offset: 0, backgroundColor: startBg },
          { offset: COLOR_START, backgroundColor: startBg },
          { offset: 1, backgroundColor: GRAY },
        ],
        { duration: totalMs, fill: "forwards" },
      );
      label?.animate(
        [
          { offset: 0, opacity: 1 },
          { offset: (SHRINK_MS * 0.55) / totalMs, opacity: 0 },
          { offset: 1, opacity: 0 },
        ],
        { duration: totalMs, fill: "forwards" },
      );
      // The ↑ arrow fades in over the swoop's tail (from 60% — after the
      // velocity stretch has started decaying, so the glyph never rides a
      // visibly scaled frame).
      arrow?.animate(
        [
          { offset: 0, opacity: 0 },
          { offset: sw(0.6), opacity: 0 },
          { offset: 1, opacity: 1 },
        ],
        { duration: totalMs, fill: "forwards" },
      );
    }
    // No frame-blending / counter-translation any more: the anchor is placed
    // at the FINAL send spot and stays screen-stable (its left/top don't move
    // as the rail narrows the overlay's right), so the flight aims at a fixed
    // point. The circle shrinks in place and arcs straight to the target — no
    // drift to compensate for (replaces the 2026-07-14 blend, which only
    // partially cancelled the ride and left the shrink pushed left).
    landTimer.current = window.setTimeout(() => setLanded(true), totalMs);
    guardTimer.current = window.setTimeout(() => cancel(), totalMs + 4000);
    return () => clearTimers();
  }, [reconnecting, clearTimers, cancel]);

  // Mid-morph WINDOW resize (maximize/restore, drag) moves where the send button
  // will settle — a change begin() couldn't predict. The rail-narrowing on
  // connect is already baked into the measured target, but a window resize is
  // not: the anchor was pinned to the pre-resize pixel, so the circle landed at
  // the OLD window's send spot (user 2026-07-15: toggling fullscreen during the
  // morph). Re-measure the FINAL send spot (same suppressed read as begin()) and
  // re-place the anchor. A short inline transition is set FIRST so the anchor —
  // and the clone riding inside it via offset-path — SLIDES to the new spot
  // instead of teleporting; the offset-path endpoint is the anchor's own centre,
  // so the landing target follows the re-placement for free. rAF-coalesced so a
  // drag-resize storm costs one re-measure per frame.
  useEffect(() => {
    if (!reconnecting) return undefined;
    const overlay = overlayRef.current;
    const send = sendButtonRef.current;
    if (overlay === null || send === null) return undefined;
    let raf: number | null = null;
    const retarget = (): void => {
      raf = null;
      const anchor = anchorRef.current;
      if (anchor === null) return;
      const { sb, ov } = measureFinalSendBox(overlay, send);
      const box = {
        left: sb.left - ov.left,
        top: sb.top - ov.top,
        width: sb.width,
        height: sb.height,
      };
      anchorBox.current = box;
      anchor.style.transition = `left ${RETARGET_MS}ms ${E_SHRINK}, top ${RETARGET_MS}ms ${E_SHRINK}, width ${RETARGET_MS}ms ${E_SHRINK}, height ${RETARGET_MS}ms ${E_SHRINK}`;
      anchor.style.left = `${fmt(box.left)}px`;
      anchor.style.top = `${fmt(box.top)}px`;
      anchor.style.width = `${fmt(box.width)}px`;
      anchor.style.height = `${fmt(box.height)}px`;
    };
    const onResize = (): void => {
      if (raf === null) raf = requestAnimationFrame(retarget);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [reconnecting, overlayRef, sendButtonRef]);

  // Waiting pulse (2026-07-13): a slow session load holds the LANDED clone in
  // place until the hand-off — previously it just sat there, dead. A gentle
  // opacity breath (CSS, delayed 250ms so a normal fast hand-off never flashes
  // it) says "still connecting". It runs through both holds: the session load
  // (`disconnected` still true) and the arrival watch below (connected, the
  // footer still sliding up). The class must be OFF before the reveal begins:
  // an infinite opacity animation would override the reveal's opacity
  // transition on the same property — it drops in the same commit that sets
  // `revealing`.
  useEffect(() => {
    const el = cloneRef.current;
    if (el === null) return;
    const waiting = reconnecting && landed && !revealing;
    el.classList.toggle("is-waiting", waiting);
  }, [reconnecting, landed, revealing]);

  // Hand-off in two phases, fired once the clone has landed AND the session
  // has loaded (!disconnected). Phase 1: enter the cross-fade — `revealing`
  // reveals the send button and fades the clone out over REVEAL_MS via CSS.
  // Phase 2 (the timer): unmount and reset.
  //
  // Arrival watch: the anchored frame is already exactly where the send
  // button belongs in EVERY layout state, so the only thing left to wait for
  // is the footer's own entrance transition (translateY(130%) → 0, delayed
  // 400ms + ~460ms) carrying the real button up into the frame. Reveal when
  // the live send rect sits within 1px of the live anchor rect; the ~4s
  // frame guard is the last resort for a layout that never converges — it
  // SNAPS the anchor's insets to the live button first (self-heal for a
  // garbage begin()-measurement), so even the guard path reveals aligned.
  // biome-ignore lint/correctness/useExhaustiveDependencies: overlayRef/sendButtonRef are stable context refs
  useEffect(() => {
    if (!(reconnecting && landed && !disconnected) || revealing) return;
    if (landTimer.current !== null) window.clearTimeout(landTimer.current);
    landTimer.current = null;
    // Re-arm rather than disarm (audit 2026-07-24, M9). Clearing BOTH timers
    // here left `reconnecting === true` with no unconditional escape: the
    // only remaining bound was the rAF watch's own 240-frame guard, which
    // dies with the watch. If `disconnected` flips true mid-watch (a session
    // delete landing inside the hand-off window) this effect re-runs, bails
    // at the guard above, and its cleanup cancels the rAF — leaving the
    // workspace wedged with no connect button AND no composer, escapable
    // only via the top-bar new-session icon. The re-armed guard is the last
    // resort for that; `reveal()` clears it on the happy path.
    if (guardTimer.current !== null) window.clearTimeout(guardTimer.current);
    guardTimer.current = window.setTimeout(() => cancel(), WATCH_GUARD_MS);
    const reveal = (): void => {
      if (guardTimer.current !== null) {
        window.clearTimeout(guardTimer.current);
        guardTimer.current = null;
      }
      setRevealing(true);
      revealTimer.current = window.setTimeout(completeReveal, REVEAL_MS);
    };
    const overlay = overlayRef.current;
    const send = sendButtonRef.current;
    const anchor = anchorRef.current;
    if (overlay === null || send === null || anchor === null) {
      reveal();
      return undefined;
    }
    let frames = 0;
    const watch = (): void => {
      const ab = anchor.getBoundingClientRect();
      const sb = send.getBoundingClientRect();
      frames += 1;
      const arrived =
        Math.abs(sb.left - ab.left) <= 1 && Math.abs(sb.top - ab.top) <= 1;
      if (arrived || frames > 240) {
        holdFrame.current = null;
        if (!arrived) {
          const ov = overlay.getBoundingClientRect();
          anchor.style.left = `${fmt(sb.left - ov.left)}px`;
          anchor.style.top = `${fmt(sb.top - ov.top)}px`;
        }
        reveal();
        return;
      }
      holdFrame.current = requestAnimationFrame(watch);
    };
    holdFrame.current = requestAnimationFrame(watch);
    return () => {
      if (holdFrame.current !== null) {
        cancelAnimationFrame(holdFrame.current);
        holdFrame.current = null;
      }
    };
  }, [reconnecting, landed, disconnected, revealing, completeReveal, cancel]);

  return { reconnecting, revealing, anchorRef, cloneRef, begin, cancel };
}
