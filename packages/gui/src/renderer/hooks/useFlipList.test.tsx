import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FLIP_MS, useFlipList } from "./useFlipList.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Test harness: a container of [data-flip-key] rows whose vertical
 *  positions are mocked per key, so reorders are observable in jsdom
 *  (which has no real layout). */
function Harness(props: {
  readonly keys: readonly string[];
  readonly tops: Readonly<Record<string, number>>;
  readonly lefts?: Readonly<Record<string, number>>;
  readonly reduced?: boolean;
  readonly searchOpen?: boolean;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useFlipList(ref, props.keys, props.reduced ?? false, props.searchOpen);
  return (
    <div ref={ref}>
      {props.keys.map((k) => (
        <div
          key={k}
          data-flip-key={k}
          ref={(el) => {
            if (el) {
              el.getBoundingClientRect = () =>
                ({
                  top: props.tops[k] ?? 0,
                  left: props.lefts?.[k] ?? 0,
                }) as DOMRect;
            }
          }}
        >
          {k}
        </div>
      ))}
    </div>
  );
}

function mockAnimate(): ReturnType<typeof vi.fn> {
  const animate = vi.fn();
  // jsdom has no Element.animate; install a recording stub.
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
  return animate;
}

describe("useFlipList", () => {
  it("glides a row from its previous to its new position when it moves", () => {
    const animate = mockAnimate();
    const { rerender } = render(
      <Harness keys={["a", "b", "c"]} tops={{ a: 0, b: 60, c: 120 }} />,
    );
    expect(animate).not.toHaveBeenCalled(); // first layout: nothing to glide from
    // "c" jumps to the top (activation), others shift down.
    act(() => {
      rerender(
        <Harness keys={["c", "a", "b"]} tops={{ c: 0, a: 60, b: 120 }} />,
      );
    });
    // Every moved row gets a translate-from-delta → none animation.
    expect(animate).toHaveBeenCalledTimes(3);
    const calls = animate.mock.calls.map((c) => c[0][0].transform);
    expect(calls).toContain("translateY(120px)"); // c: was 120, now 0
    expect(calls).toContain("translateY(-60px)"); // a: was 0, now 60
    expect(calls).toContain("translateY(-60px)"); // b: was 60, now 120
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: FLIP_MS });
  });

  it("does not animate unmoved rows or newly-appearing rows", () => {
    const animate = mockAnimate();
    const { rerender } = render(
      <Harness keys={["a", "b"]} tops={{ a: 0, b: 60 }} />,
    );
    // "x" appears at the end; a and b stay put.
    act(() => {
      rerender(
        <Harness keys={["a", "b", "x"]} tops={{ a: 0, b: 60, x: 120 }} />,
      );
    });
    expect(animate).not.toHaveBeenCalled();
  });

  it("animates survivors gliding up after a deletion", () => {
    const animate = mockAnimate();
    const { rerender } = render(
      <Harness keys={["a", "b", "c"]} tops={{ a: 0, b: 60, c: 120 }} />,
    );
    act(() => {
      rerender(<Harness keys={["a", "c"]} tops={{ a: 0, c: 60 }} />);
    });
    expect(animate).toHaveBeenCalledTimes(1); // only c moved (120 → 60)
    expect(animate.mock.calls[0]?.[0][0].transform).toBe("translateY(60px)");
  });

  it("ignores horizontal-only deltas (layout noise in a vertical list)", () => {
    // A sideways glide is never a legitimate reorder motion; animating dx
    // produced a visible right-then-back drift during session switches
    // (user 2026-06-13).
    const animate = mockAnimate();
    const { rerender } = render(
      <Harness
        keys={["a", "b"]}
        tops={{ a: 0, b: 60 }}
        lefts={{ a: 0, b: 0 }}
      />,
    );
    act(() => {
      rerender(
        <Harness
          keys={["a", "b"]}
          tops={{ a: 0, b: 60 }}
          lefts={{ a: 25, b: 25 }}
        />,
      );
    });
    expect(animate).not.toHaveBeenCalled();
  });

  it("finishes in-flight glides before measuring (no self-feeding deltas)", () => {
    const animate = mockAnimate();
    const finish = vi.fn();
    (
      HTMLElement.prototype as unknown as { getAnimations: unknown }
    ).getAnimations = vi.fn(() => [{ finish }]);
    try {
      const { rerender } = render(
        <Harness keys={["a", "b"]} tops={{ a: 0, b: 60 }} />,
      );
      act(() => {
        rerender(<Harness keys={["b", "a"]} tops={{ b: 0, a: 60 }} />);
      });
      // Each measured element had its running animations snapped to the end
      // state first — both commits, both elements.
      expect(finish).toHaveBeenCalled();
      expect(animate).toHaveBeenCalledTimes(2); // both rows moved vertically
    } finally {
      (
        HTMLElement.prototype as unknown as { getAnimations?: unknown }
      ).getAnimations = undefined;
    }
  });

  it("does NOT glide when rows move but the order is unchanged (e.g. the search field pushing the list)", () => {
    // The search reveal is a CSS height transition that slides the rows; a
    // FLIP glide on top fought it and snapped the content up ahead of the
    // collapsing field (user 2026-06-13). Same keys/order, both rows shifted.
    const animate = mockAnimate();
    const { rerender } = render(
      <Harness keys={["a", "b"]} tops={{ a: 0, b: 60 }} />,
    );
    act(() => {
      rerender(<Harness keys={["a", "b"]} tops={{ a: 40, b: 100 }} />);
    });
    expect(animate).not.toHaveBeenCalled();
  });

  it("suppresses the glide on a search toggle even if the order changed (close-with-active-query)", () => {
    // Closing search clears the query in the same commit, which can reorder
    // the list — but the field/content motion is still the CSS collapse, so
    // no FLIP glide should fire on that toggle commit.
    const animate = mockAnimate();
    const { rerender } = render(
      <Harness keys={["a", "b"]} tops={{ a: 0, b: 60 }} searchOpen={false} />,
    );
    act(() => {
      rerender(
        <Harness keys={["b", "a"]} tops={{ b: 0, a: 60 }} searchOpen={true} />,
      );
    });
    expect(animate).not.toHaveBeenCalled();
  });

  it("does nothing under reduced motion", () => {
    const animate = mockAnimate();
    const { rerender } = render(
      <Harness keys={["a", "b"]} tops={{ a: 0, b: 60 }} reduced />,
    );
    act(() => {
      rerender(<Harness keys={["b", "a"]} tops={{ b: 0, a: 60 }} reduced />);
    });
    expect(animate).not.toHaveBeenCalled();
  });

  it("repaints each moved row at the START of its glide (heals the stale raster before it shows)", () => {
    // A theme flip can leave a FLIP-moved row with a STALE composite texture —
    // dimmed until hover (user 2026-07-15, live-verified). The hook nudges the
    // row's background (the hover invalidation) SYNCHRONOUSLY when the glide
    // starts, so the row's new transform layer rasters fresh from frame 1.
    // Healing at the glide's END instead left the stale mask visible for the
    // whole glide and then cleared it in view — a flash on every delete. rAF is
    // captured so the set-then-clear is observable in order.
    const rafCbs: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCbs.push(cb);
      return rafCbs.length;
    });
    try {
      mockAnimate();
      const { rerender, container } = render(
        <Harness keys={["a", "b", "c"]} tops={{ a: 0, b: 60, c: 120 }} />,
      );
      act(() => {
        rerender(
          <Harness keys={["c", "a", "b"]} tops={{ c: 0, a: 60, b: 120 }} />,
        );
      });
      const rowA = container.querySelector(
        '[data-flip-key="a"]',
      ) as HTMLElement;
      // Set synchronously as the glide starts — not deferred to its end.
      expect(rowA.style.backgroundColor).toBe("rgba(128, 128, 128, 0.003)");
      act(() => {
        for (const cb of rafCbs.splice(0)) cb(0);
      });
      expect(rowA.style.backgroundColor).toBe(""); // nudge cleared next frame
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not nudge the active row (its tint must never flash)", () => {
    mockAnimate();
    const { rerender, container } = render(
      <Harness keys={["a", "b"]} tops={{ a: 0, b: 60 }} />,
    );
    // Mark b active BEFORE the reorder that moves it — the glide's synchronous
    // repaint must skip an .is-active row (React does not own these classNames,
    // so the manually-added class survives the rerender).
    const rowB = container.querySelector('[data-flip-key="b"]') as HTMLElement;
    rowB.classList.add("is-active");
    act(() => {
      rerender(<Harness keys={["b", "a"]} tops={{ b: 0, a: 60 }} />);
    });
    expect(rowB.style.backgroundColor).toBe(""); // active row skipped
  });
});
