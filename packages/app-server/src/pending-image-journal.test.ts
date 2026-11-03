import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PendingImageJournal } from "./pending-image-journal.js";
const fault = vi.hoisted(() => ({ write: false }));
vi.mock("@herta/core", async load => {
  const actual = await load<typeof import("@herta/core")>();
  return { ...actual, writeFileAtomicSync: (...args: Parameters<typeof actual.writeFileAtomicSync>) => {
    if (fault.write) throw new Error("injected write failure");
    return actual.writeFileAtomicSync(...args);
  } };
});
let root: string;
let path: string;
const picture = { id: "one", name: "test.png", path: ".herta/attachments/task/test.png", width: 2, height: 2 };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "herta-image-journal-")); path = join(root, "pending.json"); fault.write = false; });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
it("restores a saved queue in a fresh instance, then durably removes it", () => {
  const first = new PendingImageJournal(path, "task");
  expect(first.read().images).toEqual([]);
  first.replace(0, [picture]);
  const second = new PendingImageJournal(path, "task");
  expect(second.read()).toMatchObject({ revision: 1, images: [picture] });
  second.replace(1, []);
  expect(new PendingImageJournal(path, "task").read()).toMatchObject({ revision: 2, images: [] });
});
it("rejects a stale async writer without replacing the latest queue", () => {
  const first = new PendingImageJournal(path, "task");
  const second = new PendingImageJournal(path, "task");
  first.replace(0, [picture]);
  expect(() => second.replace(0, [])).toThrow("已更新");
  expect(first.read().images).toEqual([picture]);
});
it.each(["broken", JSON.stringify({ version: 2, sessionId: "task", revision: 1, images: [] }), JSON.stringify({ version: 1, sessionId: "other", revision: 1, images: [] })])("preserves an invalid original: %s", raw => {
  writeFileSync(path, raw);
  const journal = new PendingImageJournal(path, "task");
  expect(() => journal.read()).toThrow("原文件保留");
  expect(() => journal.replace(0, [])).toThrow();
  expect(readFileSync(path, "utf8")).toBe(raw);
});
it.each(["../secret", ".herta/attachments/other/test.png", ".herta/attachments/task/../secret", ".herta/attachments/task/a:stream", ".herta/attachments/task/a\\b.png"])("rejects unsafe reference %s", bad => {
  expect(() => new PendingImageJournal(path, "task").replace(0, [{ ...picture, path: bad }])).toThrow();
});
it("rejects duplicates and over-capacity queues", () => {
  const journal = new PendingImageJournal(path, "task");
  expect(() => journal.replace(0, [picture, picture])).toThrow();
  expect(() => journal.replace(0, Array.from({ length: 6 }, (_, i) => ({ ...picture, id: `id${i}`, path: `.herta/attachments/task/${i}.png` })))).toThrow();
});
it("preserves the prior complete manifest on a failed write", () => {
  const journal = new PendingImageJournal(path, "task");
  journal.replace(0, [picture]);
  fault.write = true;
  expect(() => journal.replace(1, [])).toThrow("injected");
  expect(new PendingImageJournal(path, "task").read()).toMatchObject({ revision: 1, images: [picture] });
});
it("R98 sets an unreadable manifest aside byte for byte, then starts again at revision 0", () => {
  writeFileSync(path, "broken-original");
  const journal = new PendingImageJournal(path, "task");
  const backup = journal.quarantine(new Date("2026-10-25T12:00:00.000Z"));
  expect(backup).toBe("pending.json.damaged-2026-10-25T12-00-00-000Z");
  expect(readFileSync(join(root, backup), "utf8")).toBe("broken-original");
  expect(existsSync(path)).toBe(false);
  expect(journal.read()).toMatchObject({ revision: 0, images: [] });
  expect(journal.replace(0, [picture])).toMatchObject({ revision: 1, images: [picture] });
});
it("R98 refuses to reset a readable or absent manifest", () => {
  const journal = new PendingImageJournal(path, "task");
  expect(() => journal.quarantine()).toThrow("无需重置");
  journal.replace(0, [picture]);
  expect(() => journal.quarantine()).toThrow("无需重置");
  expect(journal.read()).toMatchObject({ revision: 1, images: [picture] });
  expect(readdirSync(root)).toEqual(["pending.json"]);
});
it("R98 never overwrites an earlier backup taken at the same instant", () => {
  const at = new Date("2026-10-25T12:00:00.000Z");
  writeFileSync(path, "first");
  const first = new PendingImageJournal(path, "task").quarantine(at);
  writeFileSync(path, "second");
  const second = new PendingImageJournal(path, "task").quarantine(at);
  expect(second).not.toBe(first);
  expect(readFileSync(join(root, first), "utf8")).toBe("first");
  expect(readFileSync(join(root, second), "utf8")).toBe("second");
});
