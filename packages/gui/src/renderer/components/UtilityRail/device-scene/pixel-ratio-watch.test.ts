import { describe, expect, it, vi } from "vitest";
import { watchDevicePixelRatio } from "./pixel-ratio-watch.js";

function fakeWindow(dpr: number) {
  const lists: { query: string; listeners: Set<() => void> }[] = [];
  const win = {
    devicePixelRatio: dpr,
    matchMedia: (query: string) => {
      const entry = { query, listeners: new Set<() => void>() };
      lists.push(entry);
      return {
        matches: true,
        media: query,
        addEventListener: (_t: string, l: () => void) => entry.listeners.add(l),
        removeEventListener: (_t: string, l: () => void) =>
          entry.listeners.delete(l),
      } as unknown as MediaQueryList;
    },
  };
  return {
    win,
    lists,
    /** The newest query stops matching — the window moved to another scale. */
    fire: () => {
      for (const l of [...(lists.at(-1)?.listeners ?? [])]) l();
    },
  };
}

describe("watchDevicePixelRatio (ADR 0057 §6.5)", () => {
  it("fires once per change, re-arms at the new ratio, and stops after unwatch", () => {
    const f = fakeWindow(1);
    const onChange = vi.fn();
    const stop = watchDevicePixelRatio(f.win, onChange);
    expect(f.lists.map((l) => l.query)).toEqual(["(resolution: 1dppx)"]);
    f.win.devicePixelRatio = 2;
    f.fire();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(f.lists.map((l) => l.query)).toEqual([
      "(resolution: 1dppx)",
      "(resolution: 2dppx)",
    ]);
    expect(f.lists[0]?.listeners.size).toBe(0);
    stop();
    expect(f.lists[1]?.listeners.size).toBe(0);
    f.fire();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
