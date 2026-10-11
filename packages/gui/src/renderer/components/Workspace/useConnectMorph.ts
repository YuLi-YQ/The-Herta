import { useLayoutEffect, useRef, useState } from "react";
import { useWorkspaceRefs } from "./WorkspaceRefs.js";

/** Travel time of the composer→button rise. Tuned for a deliberate, calm
 *  "lift" rather than a snap (the reconnect direction stays a 200ms fade).
 *  The cards-slide is staggered to begin 400ms in (CSS transition-delay), so
 *  the morph leads and the layout reflow follows — see reference-ux.css. */
const MORPH_MS = 800;
/** The rise distance MORPH_MS was tuned against (~1440×900: composer →
 *  workspace center ≈ 350–400px). Fullscreen roughly doubles the travel, so
 *  the duration stretches by sqrt(distance/reference), capped at 1.5× —
 *  same velocity discipline as the reconnect swoop (2026-07-13). */
const RISE_REF_PX = 380;
/** CSS twin of the old easeOutCubic the rAF rise used. */
const E_RISE = "cubic-bezier(0.215, 0.61, 0.355, 1)";
/** The static ConnectStation button's footprint (width × height, see the
 *  `.connect-station` rule). The riser morphs into exactly this so the
 *  hand-off to the static button is seamless. */
const TARGET_W = 240;
const TARGET_H = 56;

export interface ConnectMorph {
  /** True from the connected→disconnected rising-edge render through the rise's
   *  settle. The footer composer hides instantly and the static ConnectStation
   *  is withheld during this window so the flying clone is the sole visible
   *  element. */
  readonly morphing: boolean;
  /** Attach to the clone div the caller mounts (in the workspace overlay)
   *  while `morphing`. Positioned + animated imperatively from here. */
  readonly cloneRef: React.RefObject<HTMLDivElement>;
}

/**
 * Upgrades the connected→disconnected transition into a FLIP morph: the footer
 * composer visibly RISES to the centre of the workspace and morphs into the
 * `接入黑塔空间站` button, instead of A5's plain cross-fade.
 *
 * Mirrors the outgoing-send morph in Conversation.tsx (edge-detect in a LAYOUT
 * EFFECT, then animate-after-mount). An earlier version detected the edge and
 * flipped `morphing` DURING render (mutating a ref in the render body) to avoid
 * a one-frame flash of the static button; that impure render silently failed
 * under React StrictMode's double-invoked render (the morph never started in
 * the packaged app, only in the non-StrictMode tests). The robust shape:
 * - All ref mutation + the `morphing` latch live in a layout effect keyed on
 *   `disconnected` (StrictMode-safe — effects are the sanctioned place for side
 *   effects, and a layout effect runs before paint so the latch doesn't paint
 *   the un-morphed frame).
 * - For the SAME rising-edge render — before the effect has run — `morphing` is
 *   DERIVED via `pendingMorph`, computed by *reading* (never mutating)
 *   `prevDisconnected`. That keeps the clone mounting and the static button
 *   withholding correct on the rising-edge render with zero render-phase writes.
 *
 * Direction-specific by design:
 * - connected→disconnected (`!reduced`): morph (this hook).
 * - reduced motion: never morphs — A5's instant swap / cross-fade owns it.
 * - disconnected→connected (reconnect): A5's fade-through, untouched here.
 */
export function useConnectMorph(args: {
  readonly disconnected: boolean;
  readonly reduced: boolean;
  /** True while a real session is active (sessionId !== null). The morph fires
   *  only on a disconnect FROM a connected session — never on the launch edge
   *  (bootstrapping → disconnected), which is the initial state, not a
   *  transition, and must appear static (user 2026-06-20). */
  readonly connected: boolean;
}): ConnectMorph {
  const { disconnected, reduced, connected } = args;
  const { composerRef, overlayRef } = useWorkspaceRefs();
  const cloneRef = useRef<HTMLDivElement>(null);
  // Cancels the in-flight travel (WAAPI animation or the jsdom rAF-poll
  // fallback) plus its resize listener. Null when no flight is running.
  const flightCancel = useRef<(() => void) | null>(null);
  const [morphingState, setMorphing] = useState(false);
  // The composer's measured start rect, captured on the rising edge BEFORE the
  // footer fully reflows. Read by the mount-keyed animate effect.
  const startRect = useRef<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const prevDisconnected = useRef(disconnected);
  // Tracks whether a session was active just before the current render, so the
  // morph fires only on a real disconnect (connected→disconnected), not the
  // launch edge (never-connected → disconnected).
  const prevConnected = useRef(connected);
  // rAF handle for the post-rise "wait for the workspace column to finish
  // reflowing" watch (see the animate effect's onSettle). Held separately from
  // the rise's own rAF so reconnect/unmount can cancel it independently.
  const holdFrame = useRef<number | null>(null);

  // `pendingMorph`: a connected→disconnected rising edge is happening on THIS
  // render but the edge layout effect (below) hasn't latched `morphingState`
  // yet. Derived by READING `prevDisconnected` — never mutating it during
  // render (that impurity broke under StrictMode and the morph silently never
  // started). Deriving it means `morphing` is already true on the rising-edge
  // render, so the clone mounts and the static button is withheld with no
  // set-during-render. Requires the refs so a missing-ref edge falls through to
  // A5's static swap.
  const pendingMorph =
    disconnected &&
    !prevDisconnected.current &&
    prevConnected.current &&
    !reduced &&
    composerRef.current !== null &&
    overlayRef.current !== null;
  const morphing = morphingState || pendingMorph;

  // Edge detection in a LAYOUT EFFECT (runs after commit, before paint), so all
  // ref mutations are effect-side and StrictMode-safe. Rising edge: sample the
  // composer rect (the footer is opacity:0 via .is-disconnected but still in
  // layout, so its rect is valid) and latch `morphingState`. Falling edge
  // (reconnect): cancel the rise and clear — A5's fade-through owns the
  // connected direction.
  // biome-ignore lint/correctness/useExhaustiveDependencies: an edge transition; refs + rise are stable
  useLayoutEffect(() => {
    const prev = prevDisconnected.current;
    const prevConn = prevConnected.current;
    prevDisconnected.current = disconnected;
    prevConnected.current = connected;
    if (!prev && disconnected) {
      // Skip the morph on the launch edge (never been connected): that's the
      // initial state, not a connected→disconnected transition.
      if (reduced || !prevConn) return;
      const composer = composerRef.current;
      const overlay = overlayRef.current;
      if (composer === null || overlay === null) return;
      const ws = overlay.getBoundingClientRect();
      const comp = composer.getBoundingClientRect();
      startRect.current = {
        left: comp.left - ws.left,
        top: comp.top - ws.top,
        width: comp.width,
        height: comp.height,
      };
      setMorphing(true);
    } else if (prev && !disconnected) {
      flightCancel.current?.();
      flightCancel.current = null;
      if (holdFrame.current !== null) {
        cancelAnimationFrame(holdFrame.current);
        holdFrame.current = null;
      }
      startRect.current = null;
      setMorphing(false);
    }
  }, [disconnected, reduced, connected]);

  // Animate once the clone has mounted (it mounts on the morphing render via the
  // caller's portal). FLIP-style: size/place the clone at the composer rect,
  // then rise it to the centred 240×56 target; the CSS shape transition
  // (`.connect-morph-clone`) morphs composer→button over the same window.
  // onSettle clears `morphing` so the static ConnectStation takes over at the
  // same spot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the clone mounting
  useLayoutEffect(() => {
    if (!morphing) return;
    const el = cloneRef.current;
    const overlay = overlayRef.current;
    const from = startRect.current;
    if (el === null || overlay === null || from === null) return;
    const ws = overlay.getBoundingClientRect();
    // The cards slide off LATER (CSS transition-delay), so during the morph the
    // workspace is still narrow (rail + gap present) and only expands to full
    // width once the cards clear. Centring on the CURRENT overlay width would
    // land the button off-centre. Instead compute the target from the FINAL
    // workspace content width — when disconnected, the rail column and the grid
    // gap both collapse to 0, so the workspace's first grid column becomes the
    // full content width: `clientWidth − paddingLeft − paddingRight` of the
    // `.workspace-body` (read live, never hardcoded). The overlay's left edge is
    // flush with that content edge, so the centred target is expressed directly
    // in overlay coordinates. Height is unaffected (no vertical reflow).
    const wb = overlay.closest(".workspace-body") as HTMLElement | null;
    // Re-measurable, not once-captured (sidebar toggle mid-morph, user
    // 2026-07-14): collapsing/expanding the sidebar changes the
    // workspace-body box WITHOUT a window resize event, so a target width
    // measured only at flight start goes stale — the settle watch below
    // would never match it (stalling to its guard) and the static button
    // then popped in at the moved centre. The wb BOX is stable through the
    // disconnect's own internal column collapse (only the column split
    // moves), so a live read is exactly "the final content width under the
    // CURRENT chrome". Without a wb (jsdom hosts) fall back to the overlay
    // width captured at flight start.
    const contentWidthNow = (): number => {
      if (wb === null) return ws.width;
      const cs = getComputedStyle(wb);
      const padLeft = Number.parseFloat(cs.paddingLeft) || 0;
      const padRight = Number.parseFloat(cs.paddingRight) || 0;
      // getBoundingClientRect().width (float) — not clientWidth (integer) — so
      // the computed centre matches the sub-pixel width the static button's CSS
      // centring resolves against, leaving no residual sub-pixel offset.
      return wb.getBoundingClientRect().width - padLeft - padRight;
    };
    const finalWorkspaceWidth = contentWidthNow();
    const targetLeft = (finalWorkspaceWidth - TARGET_W) / 2;
    const targetTop = (ws.height - TARGET_H) / 2;
    // Start the clone at the composer's footprint; the `.is-target` class drives
    // the CSS shape/colour transition toward the button look over MORPH_MS.
    el.style.width = `${Math.round(from.width)}px`;
    el.style.height = `${Math.round(from.height)}px`;
    el.style.left = `${Math.round(from.left)}px`;
    el.style.top = `${Math.round(from.top)}px`;
    el.classList.add("is-visible");
    // Force a layout read so the start geometry is committed before toggling the
    // target class — otherwise the browser may coalesce both into one frame and
    // skip the shape transition.
    void el.offsetWidth;
    el.style.width = `${TARGET_W}px`;
    el.style.height = `${TARGET_H}px`;
    el.classList.add("is-target");
    // The travel (2026-07-13, replacing the rAF left/top rise): a WAAPI
    // transform flight — COMPOSITED, so it neither invalidates layout every
    // frame (the old per-frame left/top writes landed exactly in the grid
    // collapse's 400–1200ms layout storm) nor stutters when the disconnect
    // teardown janks the main thread. Translate never rescales glyph
    // rasters, so the carried composer/label text stays crisp — the
    // "never transform text" rule guards against SCALING, and the compositor
    // moves the layer's texture without re-rasterizing. Duration scales
    // with distance (sqrt, capped 1.5×) so fullscreen doesn't triple the
    // per-frame step.
    // Deltas from the (already-committed, rounded) start position; the ≤0.5px
    // rounding residue mid-flight is invisible, and onSettle lands the exact
    // unrounded centre.
    const dx = targetLeft - from.left;
    const dy = targetTop - from.top;
    const riseMs =
      MORPH_MS *
      Math.min(1.5, Math.max(1, Math.sqrt(Math.hypot(dx, dy) / RISE_REF_PX)));
    const onSettle = (): void => {
      flightCancel.current?.();
      flightCancel.current = null;
      startRect.current = null;
      // Land the clone at the EXACT (unrounded) centre via its base
      // geometry — the fill:forwards transform is dropped by the cancel
      // above IN THE SAME task, so this paints once, pixel-exact where the
      // static ConnectStation's sub-pixel CSS centring will land it.
      el.style.transform = "none";
      el.style.left = `${targetLeft}px`;
      el.style.top = `${targetTop}px`;
      // The rise has landed the clone at the FINAL full-width centre, but the
      // static ConnectStation that takes over centres itself with
      // place-items:center INSIDE the workspace grid column — and that column
      // keeps WIDENING while the utility cards slide off (the grid-column
      // transition runs ~400ms past the 800ms rise). Handing off before the
      // column reaches full width centres the static button in a narrower
      // column, then it drifts right as the column finishes — the horizontal
      // jitter. So keep the (correctly-anchored) clone and withhold the static
      // button until the column has reached its FINAL width.
      //
      // Crucially this waits for the column to reach the LIVE content width
      // (re-read per frame — a mid-morph sidebar toggle moves the target),
      // NOT for the per-frame width delta to go small: the cards' ease-out
      // (cubic-bezier(0.2,0.85,0.2,1)) front-loads ~82% of the movement into
      // the first ~27% of the time, so by the rise's end the column is
      // already ~95% expanded and creeping sub-pixel per frame while still
      // tens of px short — a "delta small" test hands off there and still
      // jitters. The target comparison only matches at the true end.
      let guard = 0;
      const watchSettle = (): void => {
        const w = overlay.getBoundingClientRect().width;
        const target = contentWidthNow();
        guard += 1;
        // `guard` (~3s @60fps) is a safety cap so a layout that never reaches
        // the target can't pin the clone forever.
        if (w >= target - 1 || guard > 180) {
          // The chrome may have moved since the flight was aimed (sidebar
          // toggle, no window resize event): land the clone on the CURRENT
          // centre before handing off, or the static button pops in
          // sideways. The glide is waited out on the rAF clock (matching
          // the rise's jsdom fallback) so reconnect/unmount can cancel it
          // through the same holdFrame handle.
          const trueLeft = (target - TARGET_W) / 2;
          const parsed = Number.parseFloat(el.style.left);
          const currentLeft = Number.isNaN(parsed) ? trueLeft : parsed;
          if (Math.abs(trueLeft - currentLeft) > 1) {
            el.style.transition = "left 180ms cubic-bezier(0.2,0.85,0.2,1)";
            el.style.left = `${trueLeft}px`;
            const glideStart = performance.now();
            const waitGlide = (): void => {
              if (performance.now() - glideStart >= 190) {
                holdFrame.current = null;
                setMorphing(false);
                return;
              }
              holdFrame.current = requestAnimationFrame(waitGlide);
            };
            holdFrame.current = requestAnimationFrame(waitGlide);
            return;
          }
          holdFrame.current = null;
          setMorphing(false);
          return;
        }
        holdFrame.current = requestAnimationFrame(watchSettle);
      };
      holdFrame.current = requestAnimationFrame(watchSettle);
    };
    // A viewport resize mid-flight moves the once-measured landing centre
    // (same hazard useRiseAnimation covered, audit 2026-07-10): settle
    // IMMEDIATELY — the watch then hands off to the static button, which
    // fresh layout centres correctly.
    const onResize = (): void => onSettle();
    window.addEventListener("resize", onResize);
    if (typeof el.animate === "function") {
      const anim = el.animate(
        [
          { transform: "translate(0px, 0px)" },
          { transform: `translate(${dx}px, ${dy}px)` },
        ],
        { duration: riseMs, easing: E_RISE, fill: "forwards" },
      );
      anim.onfinish = onSettle;
      flightCancel.current = () => {
        window.removeEventListener("resize", onResize);
        anim.onfinish = null;
        anim.cancel();
      };
    } else {
      // jsdom/test fallback: no WAAPI — poll the (mocked) rAF clock and
      // settle once the flight duration elapses. No per-frame writes; the
      // tests drive this via their pump() clock.
      const started = performance.now();
      let poll: number | null = null;
      const tick = (): void => {
        if (performance.now() - started >= riseMs) {
          poll = null;
          onSettle();
          return;
        }
        poll = requestAnimationFrame(tick);
      };
      poll = requestAnimationFrame(tick);
      flightCancel.current = () => {
        window.removeEventListener("resize", onResize);
        if (poll !== null) cancelAnimationFrame(poll);
        poll = null;
      };
    }
    // If `morphing` flips false before the watch resolves (reconnect mid-morph),
    // this cleanup cancels the pending flight + width watch so neither can
    // fire a late setMorphing or leak a listener.
    return () => {
      flightCancel.current?.();
      flightCancel.current = null;
      if (holdFrame.current !== null) {
        cancelAnimationFrame(holdFrame.current);
        holdFrame.current = null;
      }
    };
  }, [morphing]);

  return { morphing, cloneRef };
}
