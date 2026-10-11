import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSidebarCollapsed } from "./useSidebarCollapsed.js";

const KEY = "herta.sidebar.collapsed";

describe("useSidebarCollapsed", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it("defaults to expanded (false) when storage is empty", () => {
    const { result } = renderHook(() => useSidebarCollapsed());
    expect(result.current[0]).toBe(false);
  });

  it("reads a persisted collapsed flag ('1') as true", () => {
    window.localStorage.setItem(KEY, "1");
    const { result } = renderHook(() => useSidebarCollapsed());
    expect(result.current[0]).toBe(true);
  });

  it("toggling flips the value and writes it through to localStorage", () => {
    const { result } = renderHook(() => useSidebarCollapsed());
    expect(result.current[0]).toBe(false);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    expect(window.localStorage.getItem(KEY)).toBe("1");
    act(() => result.current[1]());
    expect(result.current[0]).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBe("0");
  });
});
