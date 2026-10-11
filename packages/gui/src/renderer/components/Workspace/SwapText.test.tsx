import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SwapText } from "./SwapText.js";

describe("SwapText", () => {
  it("renders the text", () => {
    const { container } = render(
      <SwapText text="读取 scripts" reduced={false} />,
    );
    expect(container.querySelector(".swap-text__in")?.textContent).toBe(
      "读取 scripts",
    );
    expect(container.querySelector(".swap-text__out")).toBeNull();
  });

  it("animates the old text out when the text changes", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(
        <SwapText text="第一步" reduced={false} />,
      );
      rerender(<SwapText text="第二步" reduced={false} />);
      expect(container.querySelector(".swap-text__in")?.textContent).toBe(
        "第二步",
      );
      const out = container.querySelector(".swap-text__out");
      expect(out?.textContent).toBe("第一步");
      expect(out?.getAttribute("aria-hidden")).toBe("true");
      // The leaving line unmounts after the swap window.
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(container.querySelector(".swap-text__out")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the current line is-shimmer when shimmer is set (live working step)", () => {
    const { container, rerender } = render(
      <SwapText text="读取 scripts" reduced={false} shimmer />,
    );
    expect(
      container
        .querySelector(".swap-text__in")
        ?.classList.contains("is-shimmer"),
    ).toBe(true);
    // Absent prop → no shimmer (done / non-active line).
    rerender(<SwapText text="读取 scripts" reduced={false} />);
    expect(
      container
        .querySelector(".swap-text__in")
        ?.classList.contains("is-shimmer"),
    ).toBe(false);
  });

  it("swaps instantly under reduced motion (no leaving span)", () => {
    const { container, rerender } = render(
      <SwapText text="第一步" reduced={true} />,
    );
    rerender(<SwapText text="第二步" reduced={true} />);
    expect(container.querySelector(".swap-text__in")?.textContent).toBe(
      "第二步",
    );
    expect(container.querySelector(".swap-text__out")).toBeNull();
  });

  it("clears an in-flight leaving span when reduced flips on mid-swap", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(
        <SwapText text="第一步" reduced={false} />,
      );
      rerender(<SwapText text="第二步" reduced={false} />);
      expect(container.querySelector(".swap-text__out")).not.toBeNull();
      // Reduced motion turns on before the 240ms window elapses.
      rerender(<SwapText text="第二步" reduced={true} />);
      expect(container.querySelector(".swap-text__out")).toBeNull();
      // Turning it back off must not resurrect the ghost.
      rerender(<SwapText text="第二步" reduced={false} />);
      expect(container.querySelector(".swap-text__out")).toBeNull();
      expect(
        container
          .querySelector(".swap-text__in")
          ?.classList.contains("is-entering"),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
