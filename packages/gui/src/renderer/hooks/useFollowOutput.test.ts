import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useFollowOutput } from "./useFollowOutput.js";

/** A scroller with controllable geometry (jsdom has no layout), parked at its end. */
function scroller(height = 1000, client = 400) {
  const el = document.createElement("div");
  const box = { height, client };
  let top = height - client;
  Object.defineProperties(el, {
    scrollHeight: { get: () => box.height },
    clientHeight: { get: () => box.client },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, box.height - box.client));
      },
    },
  });
  document.body.append(el);
  const scrollTo = (value: number) =>
    act(() => {
      el.scrollTop = value;
      el.dispatchEvent(new Event("scroll"));
    });
  const end = () => box.height - box.client;
  return { el, box, scrollTo, end };
}

function follow(el: HTMLElement) {
  return renderHook(() => useFollowOutput({ current: el }, 48));
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("useFollowOutput", () => {
  it("keeps the newest line in view while following", () => {
    const s = scroller();
    const { result } = follow(s.el);
    s.box.height += 300;
    result.current.stick();
    expect(s.el.scrollTop).toBe(s.end());
    expect(result.current.away).toBe(false);
  });

  it("lets go on an upward wheel even inside the bottom margin", () => {
    const s = scroller();
    const { result } = follow(s.el);
    act(() => {
      s.el.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    });
    s.scrollTo(s.end() - 40);
    const kept = s.el.scrollTop;
    s.box.height += 300;
    result.current.stick();
    expect(s.el.scrollTop).toBe(kept);
    expect(result.current.following.current).toBe(false);
    expect(result.current.away).toBe(true);
  });

  it("re-arms once the reader scrolls back down to the end", () => {
    const s = scroller();
    const { result } = follow(s.el);
    act(() => {
      s.el.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    });
    s.scrollTo(s.end() - 120);
    expect(result.current.away).toBe(true);
    act(() => {
      s.el.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }));
    });
    s.scrollTo(s.end());
    expect(result.current.following.current).toBe(true);
    expect(result.current.away).toBe(false);
  });

  it("jump re-arms and moves to the newest line", () => {
    const s = scroller();
    const { result } = follow(s.el);
    act(() => {
      s.el.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    });
    s.scrollTo(s.end() - 40);
    s.box.height += 200;
    act(() => result.current.jump());
    expect(s.el.scrollTop).toBe(s.end());
    expect(result.current.following.current).toBe(true);
    expect(result.current.away).toBe(false);
  });

  it("treats upward movement without reader input as layout, not leaving", () => {
    const s = scroller();
    const { result } = follow(s.el);
    s.scrollTo(s.end() - 30);
    expect(result.current.following.current).toBe(true);
    expect(result.current.away).toBe(false);
  });

  it("lets go when a scroll key moves the transcript up", () => {
    const s = scroller();
    const { result } = follow(s.el);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    });
    s.scrollTo(s.end() - 40);
    expect(result.current.following.current).toBe(false);
    expect(result.current.away).toBe(true);
  });

  it("keeps the distance fallback for far jumps and resumes at the end", () => {
    const s = scroller();
    const { result } = follow(s.el);
    s.scrollTo(100);
    expect(result.current.away).toBe(true);
    s.scrollTo(s.end());
    expect(result.current.following.current).toBe(true);
    expect(result.current.away).toBe(false);
  });

  // R56: shrinking the window reflows the transcript taller and the viewport
  // shorter; Chromium's scroll anchoring reports a scroll before the
  // ResizeObserver runs. That scroll is layout, not the reader leaving.
  it("keeps following through a resize even when a scroll event arrives first", () => {
    const s = scroller(1000, 400);
    const { result } = follow(s.el);
    s.box.height = 1400;
    s.box.client = 300;
    s.scrollTo(s.el.scrollTop);
    expect(result.current.following.current).toBe(true);
    expect(result.current.away).toBe(false);
    expect(s.el.scrollTop).toBe(s.end());
  });

  it("stays away through a resize once the reader has left", () => {
    const s = scroller(1000, 400);
    const { result } = follow(s.el);
    act(() => {
      s.el.dispatchEvent(new WheelEvent("wheel", { deltaY: -200 }));
    });
    s.scrollTo(s.end() - 200);
    const kept = s.el.scrollTop;
    s.box.height = 1400;
    s.box.client = 300;
    s.scrollTo(kept);
    expect(result.current.following.current).toBe(false);
    expect(result.current.away).toBe(true);
    expect(s.el.scrollTop).toBe(kept);
  });

  it("ignores Ctrl+wheel, which zooms", () => {
    const s = scroller();
    const { result } = follow(s.el);
    act(() => {
      s.el.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -100, ctrlKey: true }),
      );
    });
    expect(result.current.following.current).toBe(true);
    expect(result.current.away).toBe(false);
  });
});
