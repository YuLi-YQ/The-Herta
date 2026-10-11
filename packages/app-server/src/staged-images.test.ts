import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ImageCaptioner } from "./attachments.js";
import { StagedImageStore } from "./staged-images.js";
import { makeJpeg, makePng } from "./testing/image-fixtures.js";

let ws: string;

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "staged-ws-")));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

const captioner =
  (text: string): ImageCaptioner =>
  async () =>
    text;

function makeStore(
  caption: ImageCaptioner | null = captioner("一张截图。"),
): StagedImageStore {
  return new StagedImageStore({
    workspaceRoot: () => ws,
    sessionId: "s1",
    lang: "zh",
    caption: () => caption,
  });
}

const onDisk = (relPath: string): boolean =>
  existsSync(join(ws, ...relPath.split("/")));

describe("StagedImageStore", () => {
  it("stores the picture immediately and returns what the strip needs", async () => {
    const store = makeStore();
    const r = await store.stage({
      bytes: makePng(1920, 1080),
      displayName: "shot.png",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.image).toMatchObject({
      name: "shot.png",
      width: 1920,
      height: 1080,
    });
    expect(r.image.path).toMatch(/^\.herta\/attachments\/s1\/shot-/);
    expect(onDisk(r.image.path)).toBe(true);
    expect(store.size).toBe(1);
  });

  it("nothing reaches the record until commit", async () => {
    // The whole point of staging: the strip is not the record. A picture the
    // user removes before sending must leave no trace at all.
    const store = makeStore();
    const r = await store.stage({
      bytes: makePng(8, 8),
      displayName: "a.png",
    });
    if (!r.ok) return;

    const blocks = await store.commit([r.image.id]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.body).toContain("附件 a.png");
    expect(blocks[0]?.body).toContain("一张截图。");
    expect(blocks[0]?.digest).toMatchObject({ kind: "attachment" });
  });

  it("commit takes each image exactly once", async () => {
    // A double-send (a retried IPC, a double-clicked button) must not put the
    // same picture in the record twice.
    const store = makeStore();
    const r = await store.stage({ bytes: makePng(8, 8), displayName: "a.png" });
    if (!r.ok) return;

    expect(await store.commit([r.image.id])).toHaveLength(1);
    expect(await store.commit([r.image.id])).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it("commit preserves the caller's order", async () => {
    const store = makeStore();
    const a = await store.stage({ bytes: makePng(2, 2), displayName: "a.png" });
    const b = await store.stage({
      bytes: makeJpeg(4, 4),
      displayName: "b.jpg",
    });
    if (!a.ok || !b.ok) return;

    const blocks = await store.commit([b.image.id, a.image.id]);
    expect(blocks[0]?.body).toContain("b.jpg");
    expect(blocks[1]?.body).toContain("a.png");
  });

  it("unstage deletes the stored copy — the × actually un-happens it", async () => {
    const store = makeStore();
    const r = await store.stage({
      bytes: makePng(8, 8),
      displayName: "oops.png",
    });
    if (!r.ok) return;
    expect(onDisk(r.image.path)).toBe(true);

    expect(await store.unstage(r.image.id)).toBe(true);
    expect(onDisk(r.image.path)).toBe(false);
    expect(store.size).toBe(0);
    // …and it can never be committed afterwards.
    expect(await store.commit([r.image.id])).toHaveLength(0);
  });

  it("unstage of an unknown id is a no-op, not a throw", async () => {
    expect(await makeStore().unstage("nope")).toBe(false);
  });

  it("every staged copy owns its OWN file — identical bytes never alias (2026-08-27)", async () => {
    // Content-hashed names alone aliased same-byte stagings onto one file,
    // so deleting either staged entry broke the other. Seen live in the
    // fatal form below; this pins the ownership rule directly.
    const store = makeStore();
    const bytes = makePng(6, 6);
    const a = await store.stage({ bytes, displayName: "same.png" });
    const b = await store.stage({ bytes, displayName: "same.png" });
    if (!a.ok || !b.ok) return;
    expect(a.image.path).not.toBe(b.image.path);

    expect(await store.unstage(a.image.id)).toBe(true);
    expect(onDisk(a.image.path)).toBe(false);
    // The twin's file is untouched.
    expect(onDisk(b.image.path)).toBe(true);
  });

  it("re-staging bytes a COMMITTED block cites cannot delete the record's copy (seen live 2026-08-27)", async () => {
    // The fatal sequence: stage → send (commit — the record block now cites
    // the stored path forever) → stage the same bytes again → close the
    // session (clear). Pre-fix, the second staging landed on the SAME path
    // and clear() deleted the record's picture out from under it.
    const store = makeStore();
    const bytes = makePng(9, 9);
    const sent = await store.stage({ bytes, displayName: "shot.png" });
    if (!sent.ok) return;
    const blocks = await store.commit([sent.image.id]);
    expect(blocks).toHaveLength(1);

    const again = await store.stage({ bytes, displayName: "shot.png" });
    if (!again.ok) return;
    await store.clear();

    // The abandoned staged copy is gone; the committed one still stands.
    expect(onDisk(again.image.path)).toBe(false);
    expect(onDisk(sent.image.path)).toBe(true);
  });

  it("clear abandons everything still staged and deletes the copies", async () => {
    // Session close: a picture the user never sent should not outlive the
    // composer it was sitting in.
    const store = makeStore();
    const a = await store.stage({ bytes: makePng(2, 2), displayName: "a.png" });
    const b = await store.stage({ bytes: makePng(3, 3), displayName: "b.png" });
    if (!a.ok || !b.ok) return;

    await store.clear();
    expect(store.size).toBe(0);
    expect(onDisk(a.image.path)).toBe(false);
    expect(onDisk(b.image.path)).toBe(false);
  });

  it("captioning starts at stage time, not at commit", async () => {
    // This is what hides the 2-11s caption cost under the user's typing. If
    // the call were deferred to commit, staging would buy nothing.
    let calledAt = 0;
    let n = 0;
    const slow: ImageCaptioner = async () => {
      calledAt = ++n;
      return "一张图。";
    };
    const store = makeStore(slow);
    await store.stage({ bytes: makePng(8, 8), displayName: "a.png" });
    // Already called, before anyone asked to commit.
    expect(calledAt).toBe(1);
  });

  it("a slow caption still completes the block at commit", async () => {
    // The record is append-only: there is no later moment to fill a caption
    // in, so a send that outruns the instrument must wait for it.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: ImageCaptioner = async () => {
      await gate;
      return "终于读完了。";
    };
    const store = makeStore(slow);
    const r = await store.stage({ bytes: makePng(8, 8), displayName: "a.png" });
    if (!r.ok) return;

    const pending = store.commit([r.image.id]);
    release?.();
    const blocks = await pending;
    expect(blocks[0]?.body).toContain("终于读完了。");
  });

  it("a failing instrument still yields a block — stored, not read", async () => {
    const boom: ImageCaptioner = async () => {
      throw new Error("HTTP 402");
    };
    const store = makeStore(boom);
    const r = await store.stage({ bytes: makePng(8, 8), displayName: "a.png" });
    if (!r.ok) return;

    const blocks = await store.commit([r.image.id]);
    expect(blocks[0]?.body).toContain("已存图片，未能读图");
    expect(onDisk(r.image.path)).toBe(true);
  });

  it("refuses a non-image without storing it — documents keep their own path", async () => {
    const store = makeStore();
    const r = await store.stage({
      bytes: Buffer.from("# just markdown\n"),
      displayName: "notes.md",
    });
    expect(r).toEqual({ ok: false, reason: "not_image" });
    expect(store.size).toBe(0);
  });

  it("refuses a credential-shaped name before reading anything", async () => {
    const store = makeStore();
    const r = await store.stage({
      bytes: makePng(8, 8),
      displayName: ".env",
    });
    expect(r).toEqual({ ok: false, reason: "denied" });
    expect(store.size).toBe(0);
  });

  it("sniffs pasted bytes by content, not by the name given", async () => {
    // Paste supplies both the bytes and a name the renderer made up; only the
    // bytes decide whether this is a picture.
    const store = makeStore();
    const lie = await store.stage({
      bytes: Buffer.from("not a picture at all"),
      displayName: "pasted.png",
    });
    expect(lie).toEqual({ ok: false, reason: "not_image" });

    const truth = await store.stage({
      bytes: makePng(4, 4),
      displayName: "pasted.png",
    });
    expect(truth.ok).toBe(true);
  });

  it("restage adopts a withdrawn block: caption kept, `at` stripped, file owned (rewind, 2026-08-27)", async () => {
    const store = makeStore(captioner("一张已配好文字的图。"));
    const first = await store.stage({
      bytes: makePng(7, 7),
      displayName: "shot.png",
    });
    if (!first.ok) return;
    const [committed] = await store.commit([first.image.id]);
    expect(committed).toBeDefined();
    if (committed === undefined) return;

    // The record stamped it on append; the restaged copy must NOT carry the
    // old time into a future send — the output boundary re-stamps.
    const withdrawn = { ...committed, at: "2026-08-27T00:00:00.000Z" };
    const img = store.restage(withdrawn);
    expect(img).not.toBeNull();
    if (img === null) return;
    expect(img.path).toBe(first.image.path);
    expect(img).toMatchObject({ name: "shot.png", width: 7, height: 7 });
    expect(store.size).toBe(1);

    // Re-sending returns the SAME block — caption already paid for — minus at.
    const [again] = await store.commit([img.id]);
    expect(again).toEqual(committed);
    expect(again !== undefined && "at" in again).toBe(false);
  });

  it("restage refuses a non-image or ✕-removed block — the GC keeps those", () => {
    const store = makeStore();
    expect(
      store.restage({
        kind: "system",
        label: "系统",
        body: "文档",
        digest: {
          kind: "attachment",
          name: "spec.md",
          path: ".herta/attachments/s1/spec-1.md",
          lines: 3,
          chars: 30,
        },
      }),
    ).toBeNull();
    expect(
      store.restage({
        kind: "system",
        label: "系统",
        body: "已移除",
        digest: {
          kind: "attachment",
          name: "gone.png",
          path: ".herta/attachments/s1/gone-1.png",
          lines: 0,
          chars: 0,
          image: { format: "png" },
          unreadable: "removed",
        },
      }),
    ).toBeNull();
    expect(store.size).toBe(0);
  });

  it("a restaged picture is unstageable like any other — the × deletes ITS file", async () => {
    const store = makeStore();
    const first = await store.stage({
      bytes: makePng(4, 4),
      displayName: "shot.png",
    });
    if (!first.ok) return;
    const [committed] = await store.commit([first.image.id]);
    if (committed === undefined) return;
    const img = store.restage(committed);
    if (img === null) return;
    expect(onDisk(img.path)).toBe(true);
    expect(await store.unstage(img.id)).toBe(true);
    expect(onDisk(img.path)).toBe(false);
  });

  it("list reflects what is waiting, for a renderer that reconnects", async () => {
    const store = makeStore();
    const a = await store.stage({ bytes: makePng(2, 2), displayName: "a.png" });
    if (!a.ok) return;
    expect(store.list().map((i) => i.name)).toEqual(["a.png"]);
    await store.unstage(a.image.id);
    expect(store.list()).toEqual([]);
  });
});
