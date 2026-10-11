// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSessionLifecycleGate } from "./session-lifecycle-gate.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("short session lifecycle transactions", () => {
  it("finishes old close and navigation reset before queued activation", async () => {
    const gate = createSessionLifecycleGate(),
      closing = deferred();
    let active: string | null = "old",
      pointed: string | null = "old";
    const order: string[] = [];
    const recycle = gate.run(async () => {
      await closing.promise;
      active = null;
      pointed = null;
      order.push("old-reset");
    });
    const open = gate.run(() => {
      active = "new";
      pointed = "new";
      order.push("new-open");
    });
    expect(gate.busy()).toBe(true);
    // Submit/continue can refuse synchronously instead of awaiting the queue
    // and accidentally sending a draft to the newly selected session.
    const submitted = !gate.busy();
    expect(submitted).toBe(false);
    expect(active).toBe("old");
    closing.resolve();
    await Promise.all([recycle, open]);
    expect(order).toEqual(["old-reset", "new-open"]);
    expect(active).toBe("new");
    expect(pointed).toBe("new");
    expect(gate.busy()).toBe(false);
  });
  it("recovers after a failed close and keeps busy for already queued operations", async () => {
    const gate = createSessionLifecycleGate(),
      next = deferred();
    const failed = gate.run(() => {
      throw new Error("close failed");
    });
    const following = gate.run(() => next.promise);
    await expect(failed).rejects.toThrow("close failed");
    expect(gate.busy()).toBe(true);
    next.resolve();
    await following;
    expect(gate.busy()).toBe(false);
    expect(await gate.run(() => "usable")).toBe("usable");
  });
});
