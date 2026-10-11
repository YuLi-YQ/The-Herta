import { afterEach, describe, expect, it, vi } from "vitest";
import { afterLaunch, holdLaunch, releaseLaunch } from "./launch-gate.js";

afterEach(() => {
  // Module state: leave the gate open for the next test, as it starts.
  releaseLaunch("settled");
  vi.useRealTimers();
});

describe("launch gate", () => {
  it("is open when no launch is in progress: the callback runs at once", () => {
    const fn = vi.fn();
    afterLaunch("settled", fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("held by a splash, each phase's waiters run after THAT phase, at idle", () => {
    vi.useFakeTimers();
    holdLaunch();
    const glow = vi.fn();
    const wave = vi.fn();
    afterLaunch("opening", glow);
    afterLaunch("settled", wave);
    vi.advanceTimersByTime(5000);
    expect(glow).not.toHaveBeenCalled();
    expect(wave).not.toHaveBeenCalled();

    releaseLaunch("opening");
    // Not synchronously: the next idle slot (a timer where there is none).
    expect(glow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(glow).toHaveBeenCalledTimes(1);
    expect(wave).not.toHaveBeenCalled();

    releaseLaunch("settled");
    vi.advanceTimersByTime(0);
    expect(wave).toHaveBeenCalledTimes(1);
    expect(glow).toHaveBeenCalledTimes(1);
  });

  it("settling releases the earlier phase too, and a late phase is a no-op", () => {
    vi.useFakeTimers();
    holdLaunch();
    const glow = vi.fn();
    afterLaunch("opening", glow);
    releaseLaunch("settled"); // the opening failed straight to done
    releaseLaunch("opening"); // arrives after: nothing more to do
    vi.advanceTimersByTime(0);
    expect(glow).toHaveBeenCalledTimes(1);
  });

  it("a cancelled waiter never runs — before its phase or in its idle slot", () => {
    vi.useFakeTimers();
    holdLaunch();
    const early = vi.fn();
    const late = vi.fn();
    const cancelEarly = afterLaunch("opening", early);
    const cancelLate = afterLaunch("opening", late);
    cancelEarly();
    releaseLaunch("opening");
    cancelLate(); // between the release and its idle slot
    vi.advanceTimersByTime(0);
    expect(early).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
  });
});
