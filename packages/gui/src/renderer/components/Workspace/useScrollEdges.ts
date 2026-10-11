import { type RefObject, useEffect, useState } from "react";

export interface ScrollEdges {
  readonly top: boolean;
  readonly bottom: boolean;
}

const NONE: ScrollEdges = { top: false, bottom: false };

/**
 * Tracks whether a scroll container has content hidden past its top/bottom
 * edge. Drives the conversation's frosted fog strips (spec 2026-06-12 §4):
 * an edge is "on" only when content actually overflows it, so a short
 * conversation shows no fog. Re-evaluates on scroll and — because streaming
 * grows scrollHeight without firing scroll events — on any resize of the
 * container or its direct children (ResizeObserver).
 *
 * `revision`: an optional content signal. The child-observing trick below
 * snapshots `el.children` ONCE, which is exact for a container whose direct
 * children are permanent (the conversation's single flow wrapper) but wrong
 * for one whose children are minted by React — the sidebar's per-date groups.
 * There the list renders EMPTY at mount (the session list loads async), so
 * zero children were ever observed and the fog never lit; and after a search
 * toggle the observed set is stale (audit 2026-07-24, M5). Callers with
 * React-owned children pass a value that changes with the content, which
 * re-runs the effect and re-observes. Callers that omit it are byte-identical
 * to the previous behaviour.
 */
export function useScrollEdges(
  ref: RefObject<HTMLElement>,
  revision?: unknown,
): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>(NONE);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is an opaque re-observe trigger, not a value the effect reads
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const update = (): void => {
      const top = el.scrollTop > 0;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setEdges((prev) =>
        prev.top === top && prev.bottom === bottom ? prev : { top, bottom },
      );
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    // The container plus its direct children (the content wrapper — e.g.
    // .conversation-flow / the sidebar list's groups) is the WHOLE signal:
    // any row appended, removed, or growing inside the wrapper changes the
    // wrapper's own height, so the wrapper's ResizeObserver entry fires.
    // The old MutationObserver watched the container's childList — but rows
    // churn a level DOWN inside the wrapper, so it never fired for them
    // (audit T3.7: "wrong level, correctness accidentally preserved by the
    // RO"). The wrapper resize IS the deliberate mechanism now.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [ref, revision]);
  return edges;
}
