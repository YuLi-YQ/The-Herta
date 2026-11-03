import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SystemBlock } from "@herta/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PendingImageJournal } from "./pending-image-journal.js";
import { StagedImageStore, type StagedImage } from "./staged-images.js";
import { makePng } from "./testing/image-fixtures.js";
let root: string;
let journalPath: string;
let committed: Set<string>;
const restore = vi.fn(async (image: StagedImage): Promise<SystemBlock> => ({ kind: "system", label: "系统", body: `restored ${image.name}` }));
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "herta-stage-recovery-")); journalPath = join(root, "private", "pending.json"); committed = new Set(); restore.mockClear(); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const store = () => new StagedImageStore({ workspaceRoot: () => root, sessionId: "s", lang: "zh", caption: () => null, deliver: true, pending: {
  journal: new PendingImageJournal(journalPath, "s"), restoreBlock: restore, committedPaths: () => committed,
} });
async function picture(target: StagedImageStore) {
  const result = await target.stage({ bytes: makePng(2, 2), displayName: "test.png" });
  if (!result.ok) throw new Error("fixture stage failed");
  return result.image;
}
it("suspends and recovers in a fresh instance without reading or sending pixels", async () => {
  const first = store();
  const image = await picture(first);
  await first.suspend();
  expect(first.list()).toEqual([]);
  expect(existsSync(join(root, image.path))).toBe(true);
  const reopened = store();
  expect(reopened.list()).toEqual([image]);
  expect(restore).not.toHaveBeenCalled();
  expect(await reopened.commit([image.id])).toHaveLength(1);
  expect(restore).toHaveBeenCalledExactlyOnceWith(image);
});
it("recovers a taken image if no durable record was appended before a crash", async () => {
  const first = store();
  const image = await picture(first);
  await first.commit([image.id]);
  expect(store().list()).toEqual([image]);
  expect(restore).not.toHaveBeenCalled();
});
it("excludes committed paths on reopen without deleting the record's image", async () => {
  const first = store();
  const image = await picture(first);
  await first.commit([image.id]);
  committed.add(image.path);
  const reopened = store();
  expect(reopened.list()).toEqual([]);
  expect(restore).not.toHaveBeenCalled();
  await reopened.suspend();
  expect(new PendingImageJournal(journalPath, "s").read().images).toEqual([]);
  expect(existsSync(join(root, image.path))).toBe(true);
});
it("persists explicit removal before deleting the image", async () => {
  const first = store();
  const image = await picture(first);
  await first.unstage(image.id);
  expect(store().list()).toEqual([]);
  expect(existsSync(join(root, image.path))).toBe(false);
});
it("preserves image and in-memory queue if the removal cannot be persisted", async () => {
  const first = store();
  const image = await picture(first);
  writeFileSync(journalPath, "broken");
  await expect(first.unstage(image.id)).rejects.toThrow("原文件保留");
  expect(first.list()).toEqual([image]);
  expect(existsSync(join(root, image.path))).toBe(true);
  expect(readFileSync(journalPath, "utf8")).toBe("broken");
});
it("keeps explicit abandon distinct from normal suspend", async () => {
  const first = store();
  const image = await picture(first);
  await first.clear();
  expect(store().list()).toEqual([]);
  expect(existsSync(join(root, image.path))).toBe(false);
});
it("R98 refuses to stage over an unreadable manifest, keeps it, and stages again after a reset", async () => {
  const first = store();
  const image = await picture(first);
  writeFileSync(journalPath, "broken");
  const reopened = store();
  expect(reopened.recoveryError).toContain("清单无法读取");
  expect(await reopened.stage({ bytes: makePng(2, 2), displayName: "next.png" })).toEqual({ ok: false, reason: "manifest_unreadable" });
  expect(readFileSync(journalPath, "utf8")).toBe("broken");
  const backup = reopened.resetRecovery();
  expect(readFileSync(join(root, "private", backup), "utf8")).toBe("broken");
  expect(reopened.recoveryError).toBeNull();
  // The damaged list cannot say which copies are safe to delete: the earlier copy stays.
  expect(existsSync(join(root, image.path))).toBe(true);
  const next = await picture(reopened);
  expect(store().list()).toEqual([next]);
});
it("R98 has nothing to reset when the manifest reads fine", async () => {
  const first = store();
  await picture(first);
  expect(() => first.resetRecovery()).toThrow("没有需要重置");
  expect(store().list()).toHaveLength(1);
});
it("R98 reports a pending reference that could not be saved as a refusal and drops its copy", async () => {
  const stale = store(); // read the manifest at revision 0
  await picture(store()); // another owner has since moved it to revision 1
  expect(await stale.stage({ bytes: makePng(3, 3), displayName: "late.png" })).toEqual({ ok: false, reason: "not_saved" });
  expect(stale.list()).toEqual([]);
  expect(readdirSync(join(root, ".herta", "attachments", "s"))).toHaveLength(1);
});
it("R98 reads a restored picture once at send and reuses it for the commit", async () => {
  const first = store();
  const image = await picture(first);
  await first.suspend();
  const reopened = store();
  expect(restore).not.toHaveBeenCalled();
  expect(await reopened.prepare([image.id])).toEqual([]);
  expect(restore).toHaveBeenCalledTimes(1);
  expect(await reopened.commit([image.id])).toEqual([{ kind: "system", label: "系统", body: "restored test.png" }]);
  expect(restore).toHaveBeenCalledTimes(1);
});
it("R98 reports a restored picture that cannot be read and keeps it pending", async () => {
  const first = store();
  const image = await picture(first);
  await first.suspend();
  restore.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "image-unreadable" }));
  const reopened = store();
  expect(await reopened.prepare([image.id, "unknown"])).toEqual([image.id]);
  expect(reopened.list()).toEqual([image]);
  expect(store().list()).toEqual([image]);
});
