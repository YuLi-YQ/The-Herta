import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useWindowHidden } from "./useWindowHidden.js";

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  // Restore jsdom's default so later suites see a visible document.
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

describe("useWindowHidden", () => {
  it("is false for a visible document", () => {
    const { result } = renderHook(() => useWindowHidden());
    expect(result.current).toBe(false);
  });

  it("flips true on hide and back on show (tray round-trip)", () => {
    const { result } = renderHook(() => useWindowHidden());
    act(() => setVisibility("hidden"));
    expect(result.current).toBe(true);
    act(() => setVisibility("visible"));
    expect(result.current).toBe(false);
  });

  it("reads an already-hidden document at mount", () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    const { result } = renderHook(() => useWindowHidden());
    expect(result.current).toBe(true);
  });
});
