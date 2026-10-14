// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EventEmitter } from "node:events";
const mock = vi.hoisted(() => ({ workers: [] as (EventEmitter & { terminate: ReturnType<typeof vi.fn> })[] }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { Worker: class extends EventEmitter {
    terminate = vi.fn(async () => 0);
    constructor() { super(); mock.workers.push(this); }
  } };
});
import { createChatStorageScan } from "./chat-storage-scan.js";
beforeEach(() => { mock.workers.length = 0; });
afterEach(() => vi.useRealTimers());
it("coalesces concurrent requests and terminates a completed worker", async () => {
  const scan = createChatStorageScan("fixture.json"), first = scan.run(), second = scan.run();
  expect(first).toBe(second); expect(mock.workers).toHaveLength(1);
  const usage = { historyBytes: 10 };
  mock.workers[0]!.emit("message", { ok: true, usage });
  expect(await first).toEqual(usage);
  expect(mock.workers[0]!.terminate).toHaveBeenCalledTimes(1);
  const next = scan.run(); expect(mock.workers).toHaveLength(2);
  const rejected = expect(next).rejects.toThrow("暂时无法读取");
  mock.workers[1]!.emit("error", new Error("private path")); await rejected;
});
it("times out with a bounded lifetime and a generic error", async () => {
  vi.useFakeTimers(); const scan = createChatStorageScan("fixture.json");
  const rejected = expect(scan.run()).rejects.toThrow("暂时无法读取");
  await vi.advanceTimersByTimeAsync(30000); await rejected;
  expect(mock.workers[0]!.terminate).toHaveBeenCalledTimes(1);
});
it("cancels pending work on disposal and refuses further scans", async () => {
  const scan = createChatStorageScan("fixture.json");
  const rejected = expect(scan.run()).rejects.toThrow("暂时无法读取");
  scan.dispose(); await rejected;
  await expect(scan.run()).rejects.toThrow("暂时无法读取");
  expect(mock.workers).toHaveLength(1);
});
