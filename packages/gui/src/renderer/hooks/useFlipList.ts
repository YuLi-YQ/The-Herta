import { type RefObject, useLayoutEffect, useRef } from "react";

/** Glide duration for a list reorder; matches the app's 220ms structural
 *  transitions with a touch more travel time for long jumps. */
export const FLIP_MS = 260;
/** Re-measure delay after a search toggle — longer than the 200ms search
 *  height transition so the refreshed baseline reflects settled positions. */
const SETTLE_MS = 240;

type Rect = { readonly top: number; readonly left: number };

/**
 * The theme-flip stale-composite-raster heal. When a theme flip happened
 * earlier and a row is then promoted to its OWN transform layer by the FLIP
 * glide below, Chromium can rasterize that fresh layer from a STALE tile — the
 * row renders dimmed/faded (the previous theme's ink) until a hover repaints it
 * (user 2026-07-15). Screenshot-verified live: re-rastering the `.sidebar-list`
 * mask group does NOT clear it (the moved rows are separate layers); a per-row
 * background nudge — the same paint invalidation hovering does — DOES.
 *
 * Fire it at the START of the glide (synchronously, before the first glide
 * frame paints), so the row's new layer rasters FRESH from frame 1. An earlier
 * version healed at the glide's END, which left the stale mask visible for the
 * whole glide and then cleared it in view — a mask that visibly flashed on and
 * off on every delete (user 2026-07-15). A near-transparent 1-frame background
 * is imperceptible on a normal (transparent) row; an `.is-active` row is
 * skipped so its tint never flashes (and it was just repainted on activation).
 */
function repaintRow(el: HTMLElement): void {
  if (el.classList.contains("is-active")) return;
  el.style.backgroundColor = "rgba(128, 128, 128, 0.003)";
  requestAnimationFrame(() => {
    el.style.backgroundColor = "";
  });
}

/**
 * FLIP reorder animation for a keyed list (the sidebar's session cards and
 * group labels). CSS cannot transition layout position changes caused by DOM
 * reordering, so on a genuine REORDER this measures each `[data-flip-key]`
 * descendant and plays a translateY(from→none) WAAPI glide on the movers —
 * deletions make survivors glide up, an activated session glides to the top.
 *
 * Crucially it glides ONLY when the key ORDER changed, and NEVER on the commit
 * where the search field toggled. The search open/close is a CSS height
 * transition (`.sidebar-search-wrap` max-height) that slides these rows on its
 * own 200ms timeline. The hook's stored baseline lags one toggle behind that
 * CSS — the render that opens the field measures the rows while the field is
 * still collapsed, then the rows settle lower via CSS with no re-render — so
 * the NEXT toggle (close) computed a ~full-row delta and fired a spurious
 * glide that snapped the content up ahead of the collapsing field (the
 * reported glitch, user 2026-06-13; confirmed live: 9 glides on close, 0 on
 * open). Gating glides on order-change (and suppressing on a search toggle)
 * leaves the field/content collapse entirely to the CSS, in lockstep.
 *
 * Non-gliding commits are record-only: they refresh the baseline so the next
 * real reorder glides from current positions. A search toggle additionally
 * schedules a settle-time re-measure, because its synchronous measure caught
 * the pre-transition layout. Fresh mounts (no prior rect) and reduced motion
 * never glide.
 */
export function useFlipList(
  containerRef: RefObject<HTMLElement>,
  keys: readonly string[],
  reduced: boolean,
  searchOpen?: boolean,
): void {
  const prevRects = useRef(new Map<string, Rect>());
  const prevSig = useRef<string | null>(null);
  const prevSearchOpen = useRef(searchOpen);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const sig = keys.join("\u0000");
    const orderChanged = prevSig.current !== null && prevSig.current !== sig;
    const searchToggled = prevSearchOpen.current !== searchOpen;
    prevSig.current = sig;
    prevSearchOpen.current = searchOpen;
    const glide = orderChanged && !searchToggled && !reduced;

    const measure = (doGlide: boolean): void => {
      const next = new Map<string, Rect>();
      const els = container.querySelectorAll<HTMLElement>("[data-flip-key]");
      for (const el of els) {
        const key = el.dataset.flipKey;
        if (key === undefined) continue;
        // Snap any in-flight glide to its end before measuring, so a row never
        // feeds on its own intermediate position across back-to-back commits.
        if (typeof el.getAnimations === "function") {
          for (const a of el.getAnimations()) a.finish();
        }
        const rect = el.getBoundingClientRect();
        next.set(key, { top: rect.top, left: rect.left });
        if (!doGlide) continue;
        const was = prevRects.current.get(key);
        if (was === undefined) continue;
        // Vertical only — the list never moves a row sideways, so any dx is
        // measurement noise; a dy of 0 means the row did not move.
        const dy = was.top - rect.top;
        if (dy === 0) continue;
        if (typeof el.animate !== "function") continue;
        el.animate(
          [{ transform: `translateY(${dy}px)` }, { transform: "none" }],
          { duration: FLIP_MS, easing: "cubic-bezier(0.2, 0.85, 0.2, 1)" },
        );
        // Heal the stale composite raster at the glide's START (see repaintRow),
        // so the row's new transform layer never shows a flashed stale mask.
        repaintRow(el);
      }
      prevRects.current = next; // dropped keys (deleted cards) fall away
    };

    measure(glide);

    if (searchToggled) {
      const t = window.setTimeout(() => measure(false), SETTLE_MS);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [keys, reduced, searchOpen, containerRef]);
}
