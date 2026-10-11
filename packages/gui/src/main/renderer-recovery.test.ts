import { describe, expect, it } from "vitest";
import {
  CRASH_WINDOW_MS,
  MAX_RELOADS_PER_WINDOW,
  shouldReloadAfterCrash,
} from "./renderer-recovery.js";

describe("shouldReloadAfterCrash (UX review 2026-09-22, item 7)", () => {
  it("a crashed renderer is reloaded — the window no longer stays dead", () => {
    for (const reason of ["crashed", "oom", "abnormal-exit", "killed"]) {
      expect(
        shouldReloadAfterCrash({
          reason,
          quitting: false,
          history: [],
          now: 1000,
        }),
      ).toBe(true);
    }
  });

  it("a clean exit, or any exit while quitting, is left alone", () => {
    expect(
      shouldReloadAfterCrash({
        reason: "clean-exit",
        quitting: false,
        history: [],
        now: 1000,
      }),
    ).toBe(false);
    expect(
      shouldReloadAfterCrash({
        reason: "crashed",
        quitting: true,
        history: [],
        now: 1000,
      }),
    ).toBe(false);
  });

  it("a crash loop stops being reloaded, and the guard forgets crashes older than its window", () => {
    const history: number[] = [];
    const at = (now: number): boolean =>
      shouldReloadAfterCrash({
        reason: "crashed",
        quitting: false,
        history,
        now,
      });
    for (let i = 0; i < MAX_RELOADS_PER_WINDOW; i += 1) {
      expect(at(1000 + i)).toBe(true);
    }
    expect(at(2000)).toBe(false);
    // A minute later the old crashes have aged out.
    expect(at(2000 + CRASH_WINDOW_MS + 1)).toBe(true);
  });
});
