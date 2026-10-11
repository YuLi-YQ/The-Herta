import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getNowMs, NOW_TICK_MS, subscribeNow } from "./now-tick.js";

describe("now-tick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rebaselines with the first subscriber and notifies each tick", () => {
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
    const ticks: number[] = [];
    const unsub = subscribeNow(() => ticks.push(getNowMs()));
    // The module loaded long before this subscriber; the baseline must be
    // the subscribe-time clock, not the import-time one.
    const t0 = getNowMs();
    expect(t0).toBe(Date.now());
    vi.advanceTimersByTime(NOW_TICK_MS);
    expect(ticks).toEqual([t0 + NOW_TICK_MS]);
    vi.advanceTimersByTime(NOW_TICK_MS);
    expect(ticks).toEqual([t0 + NOW_TICK_MS, t0 + 2 * NOW_TICK_MS]);
    unsub();
  });

  it("does not tick before a full interval elapses", () => {
    const ticks: number[] = [];
    const unsub = subscribeNow(() => ticks.push(getNowMs()));
    vi.advanceTimersByTime(NOW_TICK_MS - 1_000);
    expect(ticks).toEqual([]);
    unsub();
  });

  it("one interval serves every subscriber; the last unsubscribe stops it", () => {
    const a: number[] = [];
    const b: number[] = [];
    const unsubA = subscribeNow(() => a.push(1));
    const unsubB = subscribeNow(() => b.push(1));
    vi.advanceTimersByTime(NOW_TICK_MS);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    unsubA();
    vi.advanceTimersByTime(NOW_TICK_MS);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
    unsubB();
    // No subscribers → no timer: time passing notifies nothing…
    vi.advanceTimersByTime(10 * NOW_TICK_MS);
    expect(b).toHaveLength(2);
    // …and the NEXT subscriber gets a fresh baseline, not the stale tick.
    vi.setSystemTime(new Date("2026-08-25T13:00:00.000Z"));
    const unsub = subscribeNow(() => undefined);
    expect(getNowMs()).toBe(Date.now());
    unsub();
  });
});
