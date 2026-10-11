import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReducedMotion } from "./useReducedMotion.js";

describe("useReducedMotion", () => {
  let listeners: Array<(e: MediaQueryListEvent) => void>;
  let matches: boolean;

  beforeEach(() => {
    listeners = [];
    matches = false;
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
        listeners.push(cb);
      },
      removeEventListener: (
        _: string,
        cb: (e: MediaQueryListEvent) => void,
      ) => {
        listeners = listeners.filter((l) => l !== cb);
      },
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the initial matchMedia value", () => {
    matches = true;
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });

  it("returns false when reduced motion is not preferred", () => {
    matches = false;
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });
});
