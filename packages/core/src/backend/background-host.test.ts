import { describe, expect, it } from "vitest";
import type { BackgroundProcess } from "./background-host.js";
import { BackgroundHost } from "./background-host.js";

function fakeProc(
  id: string,
  running = true,
): BackgroundProcess & {
  killed: boolean;
} {
  let alive = running;
  const p = {
    id,
    argv: ["node", "-e", ""],
    killed: false,
    isRunning: () => alive,
    kill: async () => {
      p.killed = true;
      alive = false;
    },
  };
  return p;
}

describe("BackgroundHost", () => {
  it("mints unique ids and registers/gets by id", () => {
    const h = new BackgroundHost();
    const a = h.nextId();
    const b = h.nextId();
    expect(a).not.toBe(b);
    const p = fakeProc(a);
    h.register(p);
    expect(h.get(a)).toBe(p);
    expect(h.get("nope")).toBeUndefined();
    expect(h.list()).toHaveLength(1);
  });

  it("rejects duplicate ids", () => {
    const h = new BackgroundHost();
    h.register(fakeProc("x"));
    expect(() => h.register(fakeProc("x"))).toThrow(/duplicate/);
  });

  it("stopAll kills only still-running processes and returns the count", async () => {
    const h = new BackgroundHost();
    const running = fakeProc("r", true);
    const dead = fakeProc("d", false);
    h.register(running);
    h.register(dead);
    const n = await h.stopAll();
    expect(n).toBe(1);
    expect(running.killed).toBe(true);
    expect(dead.killed).toBe(false);
  });

  it("internal entries (the minimal contract's shell, ADR 0040) are reaped by stopAll but never listed, addressed, or counted", async () => {
    const h = new BackgroundHost();
    const shell = Object.assign(fakeProc("shell-1"), { internal: true });
    const userProc = fakeProc("bg-1");
    h.register(shell);
    h.register(userProc);
    expect(h.list().map((p) => p.id)).toEqual(["bg-1"]);
    expect(h.get("shell-1")).toBeUndefined();
    expect(h.getInternal("shell-1")).toBe(shell);
    const n = await h.stopAll();
    expect(shell.killed).toBe(true);
    expect(userProc.killed).toBe(true);
    // Only the model-started process is "left running at brief end".
    expect(n).toBe(1);
  });

  it("stopAll tolerates a kill that rejects (allSettled)", async () => {
    const h = new BackgroundHost();
    h.register({
      id: "boom",
      argv: [],
      isRunning: () => true,
      kill: async () => {
        throw new Error("kill failed");
      },
    });
    await expect(h.stopAll()).resolves.toBe(1);
  });
});
