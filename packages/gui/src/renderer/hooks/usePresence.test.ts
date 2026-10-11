import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePresence } from "./usePresence.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("usePresence", () => {
  it("mounts immediately on activation, opens one frame later", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ a }: { a: boolean }) => usePresence(a, 160),
      { initialProps: { a: false } },
    );
    expect(result.current.mounted).toBe(false);
    rerender({ a: true });
    expect(result.current.mounted).toBe(true);
    expect(result.current.open).toBe(false); // the collapsed mount frame
    act(() => {
      vi.advanceTimersByTime(32); // the arming rAF fires
    });
    expect(result.current.open).toBe(true);
  });

  it("closes immediately on deactivation, unmounts after exitMs", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ a }: { a: boolean }) => usePresence(a, 160),
      { initialProps: { a: true } },
    );
    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(result.current.open).toBe(true);
    rerender({ a: false });
    expect(result.current.open).toBe(false); // exit transition starts…
    expect(result.current.mounted).toBe(true); // …while still rendered
    act(() => {
      vi.advanceTimersByTime(159);
    });
    expect(result.current.mounted).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(result.current.mounted).toBe(false);
  });

  it("re-activation mid-exit cancels the unmount and re-opens in place", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ a }: { a: boolean }) => usePresence(a, 160),
      { initialProps: { a: true } },
    );
    act(() => {
      vi.advanceTimersByTime(32);
    });
    rerender({ a: false });
    act(() => {
      vi.advanceTimersByTime(100); // mid-exit
    });
    expect(result.current.mounted).toBe(true);
    rerender({ a: true });
    act(() => {
      vi.advanceTimersByTime(500); // the cancelled unmount never fires
    });
    expect(result.current.mounted).toBe(true);
    expect(result.current.open).toBe(true);
  });

  it("an initially-inactive hook schedules nothing", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => usePresence(false, 160));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.mounted).toBe(false);
    expect(result.current.open).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
