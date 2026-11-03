import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { restoreStagedImage } from "./restore-staged-image.js";
import { makePng } from "./testing/image-fixtures.js";
let root: string;
const image = { id: "one", name: "test.png", path: ".herta/attachments/s/test.png" };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "herta-safe-recovery-")); mkdirSync(join(root, ".herta", "attachments", "s"), { recursive: true }); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
it("reads and sniffs only the owned copy on explicit recovery", async () => {
  writeFileSync(join(root, image.path), makePng(2, 3));
  expect(await restoreStagedImage(root, "s", image, "zh")).toMatchObject({ digest: { kind: "attachment", image: { format: "png", width: 2, height: 3 } } });
});
it.each(["missing", "not-image", "oversize"])("refuses %s without inventing image content", async (kind) => {
  if (kind !== "missing") writeFileSync(join(root, image.path), kind === "oversize" ? Buffer.alloc(8 * 1024 * 1024 + 1) : "not picture");
  await expect(restoreStagedImage(root, "s", image, "zh")).rejects.toMatchObject({ code: "image-unreadable" });
});
it("refuses another session's path", async () => {
  writeFileSync(join(root, image.path), makePng(2, 2));
  await expect(restoreStagedImage(root, "other", image, "zh")).rejects.toMatchObject({ code: "image-unreadable" });
});
it("refuses a directory junction instead of reading its target", async () => {
  const external = mkdtempSync(join(tmpdir(), "herta-safe-external-"));
  try {
    writeFileSync(join(external, "test.png"), makePng(2, 2));
    const dir = join(root, ".herta", "attachments", "s");
    rmSync(dir, { recursive: true });
    symlinkSync(external, dir, "junction");
    await expect(restoreStagedImage(root, "s", image, "zh")).rejects.toMatchObject({ code: "image-unreadable" });
    rmSync(dir); // remove only the test junction
  } finally { rmSync(external, { recursive: true, force: true }); }
});
