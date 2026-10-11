import { performance as userTiming } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { journeyMark, journeyMarkAfterPaint } from "./journey.js";

// jsdom's `performance` has no User Timing (the module no-ops there, which
// is its guard working); Node's does, and is what these tests hand it.
const marks = (name: string): PerformanceEntry[] =>
  userTiming.getEntriesByName(`herta:${name}`, "mark");

describe("journey marks", () => {
  let frames: Array<() => void>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("performance", userTiming);
    userTiming.clearMarks();
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      frames.push(cb);
      return frames.length;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("marks now, keeping only the latest mark per name", () => {
    journeyMark("send:start");
    journeyMark("send:start");
    expect(marks("send:start")).toHaveLength(1);
  });

  it("marks after the next frame's paint — not before the frame", () => {
    journeyMarkAfterPaint("send:echo-painted");
    expect(marks("send:echo-painted")).toHaveLength(0);
    // The frame runs, then the task it queued (after that frame's paint).
    for (const f of frames.splice(0)) f();
    expect(marks("send:echo-painted")).toHaveLength(0);
    vi.advanceTimersByTime(0);
    const [m] = marks("send:echo-painted");
    expect((m as PerformanceMark).detail).toBeNull();
    // The cap timer was cleared: no second, late mark follows.
    vi.advanceTimersByTime(2000);
    expect(marks("send:echo-painted")).toHaveLength(1);
  });

  it("after the frame, a user-blocking postTask runs the mark ahead of queued timers", () => {
    const posted: Array<{ cb: () => void; priority: string }> = [];
    vi.stubGlobal("scheduler", {
      postTask: (cb: () => void, opts: { priority: string }) => {
        posted.push({ cb, priority: opts.priority });
        return Promise.resolve();
      },
    });
    journeyMarkAfterPaint("send:echo-painted");
    for (const f of frames.splice(0)) f();
    expect(posted.map((p) => p.priority)).toEqual(["user-blocking"]);
    expect(marks("send:echo-painted")).toHaveLength(0);
    posted[0]?.cb();
    expect(marks("send:echo-painted")).toHaveLength(1);
    // No timer was queued for it, and the cap was cleared.
    vi.advanceTimersByTime(2000);
    expect(marks("send:echo-painted")).toHaveLength(1);
  });

  it("an occluded window (no frames) still marks, flagged late", () => {
    journeyMarkAfterPaint("open-session:painted");
    vi.advanceTimersByTime(999);
    expect(marks("open-session:painted")).toHaveLength(0);
    vi.advanceTimersByTime(1);
    const [m] = marks("open-session:painted");
    expect((m as PerformanceMark).detail).toEqual({ late: true });
  });
});
