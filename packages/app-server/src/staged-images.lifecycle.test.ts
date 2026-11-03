import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { StagedImageStore } from "./staged-images.js";
import { makePng } from "./testing/image-fixtures.js";
const delayed = vi.hoisted(() => ({ wait: undefined as undefined | (() => Promise<void>), stored: "" }));
vi.mock("./attachments.js", async (load) => {
  const actual = await load<typeof import("./attachments.js")>();
  return { ...actual, stageImageSource: async (...args: Parameters<typeof actual.stageImageSource>) => {
    const result = await actual.stageImageSource(...args);
    if (result.ok) delayed.stored = result.stored.relPath;
    await delayed.wait?.();
    return result;
  } };
});
it("R93 a clear during disk staging cannot revive the image or leave its copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "herta-stage-lifecycle-"));
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  delayed.wait = () => { entered(); return gate; };
  const caption = vi.fn(async () => "unused");
  const store = new StagedImageStore({ workspaceRoot: () => root, sessionId: "test", lang: "zh", caption: () => caption });
  try {
    const staging = store.stage({ bytes: makePng(2, 2), displayName: "test.png" });
    await ready;
    expect(existsSync(join(root, delayed.stored))).toBe(true);
    await store.clear();
    release();
    expect(await staging).toMatchObject({ ok: false });
    expect(store.list()).toEqual([]);
    expect(caption).not.toHaveBeenCalled();
    expect(existsSync(join(root, delayed.stored))).toBe(false);
  } finally {
    release();
    delayed.wait = undefined;
    await store.clear();
    rmSync(root, { recursive: true, force: true });
  }
});
