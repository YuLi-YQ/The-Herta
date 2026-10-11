import { describe, expect, it, vi } from "vitest";
import { DreamTrigger, type DreamTriggerOptions } from "./dream-trigger.js";

const DAY = 24 * 60 * 60 * 1000;

function setup(over: Partial<DreamTriggerOptions> = {}) {
  const clock = { t: 0 };
  const runPass = vi.fn(async () => {});
  const opts: DreamTriggerOptions = {
    idleMs: 100,
    cooldownMs: 7 * DAY,
    minRetryMs: 1000,
    enabled: true,
    now: () => clock.t,
    lastFullPassAt: () => null,
    hasEnoughMaterial: () => true,
    runPass,
    ...over,
  };
  const trig = new DreamTrigger(opts);
  return { trig, runPass, clock };
}

describe("DreamTrigger", () => {
  it("a cooldown-rejected tick still counts as an attempt (audit BL9)", async () => {
    // lastAttempt used to be set only after the cooldown and material gates
    // passed, so a tick the cooldown rejected never armed the minRetryMs
    // backoff — and the material gate below it re-ran a full synchronous
    // session listing on the Electron main thread every poll, 12×/hour, for a
    // pass that could not fire.
    const material = vi.fn(() => true);
    const { trig, clock } = setup({
      lastFullPassAt: () => 0, // inside the 7-day cooldown
      hasEnoughMaterial: material,
    });
    trig.noteActivity();
    clock.t = 3 * DAY;
    await trig.tick();
    // Gate 3 rejected it before the material scan.
    expect(material).not.toHaveBeenCalled();

    // A second tick inside minRetryMs is now short-circuited by gate 2 —
    // pre-fix it fell through to gate 3 again on every single poll.
    clock.t = 3 * DAY + 100; // < minRetryMs (1000)
    await trig.tick();
    expect(material).not.toHaveBeenCalled();
  });

  it("never fires while a turn is in flight, however long ago the input came — and fires once it ends (dream review 2026-09-22, finding 2)", async () => {
    const busy = { now: true };
    const { trig, runPass, clock } = setup({ isBusy: () => busy.now });
    trig.noteActivity(); // the user's request, at 0
    // A 板砖 run long past the idle window, or a gate parked while away.
    clock.t = 10_000;
    await trig.tick();
    expect(runPass).not.toHaveBeenCalled();
    // The turn ends: busy is not an attempt, so no backoff delays the pass.
    busy.now = false;
    clock.t = 10_001;
    await trig.tick();
    expect(runPass).toHaveBeenCalledTimes(1);
  });

  it("fires once idle, never-run, and material is present", async () => {
    const { trig, runPass, clock } = setup();
    trig.noteActivity(); // lastActivity = 0
    clock.t = 50;
    await trig.tick();
    expect(runPass).not.toHaveBeenCalled(); // 50 < idleMs (100)
    clock.t = 200;
    await trig.tick();
    expect(runPass).toHaveBeenCalledTimes(1);
  });

  it("does not fire while a full pass completed within the cooldown", async () => {
    const { trig, runPass, clock } = setup({ lastFullPassAt: () => 0 });
    trig.noteActivity();
    clock.t = 3 * DAY; // idle, but only 3 days since last pass < 7-day cooldown
    await trig.tick();
    expect(runPass).not.toHaveBeenCalled();
  });

  it("fires once the cooldown has elapsed", async () => {
    const { trig, runPass, clock } = setup({ lastFullPassAt: () => 0 });
    trig.noteActivity();
    clock.t = 8 * DAY;
    await trig.tick();
    expect(runPass).toHaveBeenCalledTimes(1);
  });

  it("does not fire when the material gate is unsatisfied, even if idle + cooldown pass", async () => {
    const { trig, runPass, clock } = setup({
      lastFullPassAt: () => 0,
      hasEnoughMaterial: () => false,
    });
    trig.noteActivity();
    clock.t = 8 * DAY;
    await trig.tick();
    expect(runPass).not.toHaveBeenCalled();
  });

  it("evaluates the material gate only after idle + cooldown pass (short-circuit)", async () => {
    const hasEnoughMaterial = vi.fn(() => true);
    const { trig, clock } = setup({
      lastFullPassAt: () => 0,
      hasEnoughMaterial,
    });
    trig.noteActivity();
    clock.t = 50; // not idle
    await trig.tick();
    expect(hasEnoughMaterial).not.toHaveBeenCalled();
    clock.t = 3 * DAY; // idle, but within cooldown
    await trig.tick();
    expect(hasEnoughMaterial).not.toHaveBeenCalled();
    clock.t = 8 * DAY; // idle + cooldown elapsed
    await trig.tick();
    expect(hasEnoughMaterial).toHaveBeenCalledTimes(1);
  });

  it("backs off for minRetryMs after a no-op pass (cadence anchor unchanged)", async () => {
    // lastFullPassAt stays null — simulates a pass that returned without
    // completing (e.g. missing API key), so the cooldown never blocks.
    const { trig, runPass, clock } = setup({ minRetryMs: 1000 });
    trig.noteActivity(); // lastActivity = 0 → idle holds for all t ≥ 100
    clock.t = 8 * DAY;
    await trig.tick();
    expect(runPass).toHaveBeenCalledTimes(1);
    clock.t = 8 * DAY + 500; // within minRetryMs of the attempt
    await trig.tick();
    expect(runPass).toHaveBeenCalledTimes(1);
    clock.t = 8 * DAY + 1500; // beyond minRetryMs
    await trig.tick();
    expect(runPass).toHaveBeenCalledTimes(2);
  });

  it("noteActivity resets the idle clock", async () => {
    const { trig, runPass, clock } = setup({ lastFullPassAt: () => 0 });
    trig.noteActivity(); // t=0
    clock.t = 8 * DAY; // would be idle…
    trig.noteActivity(); // …but activity resets lastActivity to 8 days
    await trig.tick();
    expect(runPass).not.toHaveBeenCalled(); // now - lastActivity = 0 < idleMs
  });

  it("does nothing when disabled", async () => {
    const { trig, runPass, clock } = setup({ enabled: false });
    trig.noteActivity();
    clock.t = 30 * DAY;
    await trig.tick();
    expect(runPass).not.toHaveBeenCalled();
  });

  it("re-entrancy guard: a concurrent tick() while runPass runs is a no-op", async () => {
    let resolve!: () => void;
    let count = 0;
    const runPass = () =>
      new Promise<void>((r) => {
        count++;
        resolve = r;
      });
    const clock = { t: 0 };
    const trig = new DreamTrigger({
      idleMs: 1,
      cooldownMs: 1,
      minRetryMs: 1,
      enabled: true,
      now: () => clock.t,
      lastFullPassAt: () => null,
      hasEnoughMaterial: () => true,
      runPass,
    });
    trig.noteActivity(); // lastActivity = 0
    clock.t = 1000; // idle, past cooldown + backoff
    const p1 = trig.tick(); // starts runPass; running = true
    const p2 = trig.tick(); // running === true → must no-op
    resolve();
    await Promise.all([p1, p2]);
    expect(count).toBe(1);
  });
});
