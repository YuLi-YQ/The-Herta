import { describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../shared/herta-chat.js";
import { memoryIdb } from "../test-utils/memory-idb.js";
import { pendingChatRecordFiles, pendingChatStore } from "./pending-chat-attachments.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const picture: ChatAttachment = { name: "shot.png", text: "", image: { mimeType: "image/png", data: PNG } };
const notes: ChatAttachment = { name: "notes.md", text: "# notes" };
const paper: ChatAttachment = { name: "paper.pdf", text: "page one", format: "pdf", pages: 2 };
const record = (chatId: string, files: unknown[], version = 1) => ({ version, chatId, files });

describe("pending chat attachments kept between launches (R101)", () => {
  it("gives back what a chat saved, per chat, and nothing for a chat that saved none", async () => {
    const mem = memoryIdb();
    const store = pendingChatStore(mem.idb);
    await expect(store.read("chat-a")).resolves.toEqual({ files: [] });
    await expect(store.write("chat-a", [picture, notes])).resolves.toBeUndefined();
    await expect(store.write("chat-b", [paper])).resolves.toBeUndefined();
    // A new store is a new launch: only IndexedDB carries the files across.
    const next = pendingChatStore(mem.idb);
    await expect(next.read("chat-a")).resolves.toEqual({ files: [picture, notes] });
    await expect(next.read("chat-b")).resolves.toEqual({ files: [paper] });
    await expect(next.read("chat-c")).resolves.toEqual({ files: [] });
    // Writes ask for strict durability: these are files the person chose to send.
    expect(new Set(mem.seen.durability)).toEqual(new Set(["strict"]));
  });

  it("removes the record when the list empties (sent, or every file removed)", async () => {
    const mem = memoryIdb();
    const store = pendingChatStore(mem.idb);
    await store.write("chat-a", [notes]);
    expect(mem.pending().has("chat-a")).toBe(true);
    await expect(store.write("chat-a", [])).resolves.toBeUndefined();
    expect(mem.pending().has("chat-a")).toBe(false);
    await expect(store.read("chat-a")).resolves.toEqual({ files: [] });
  });

  it("refuses records this build cannot use instead of sending them half", () => {
    const ref = { name: "old.png", text: "", imageRef: { storage: "sha256", sha256: "a".repeat(64), mimeType: "image/png" } };
    for (const bad of [
      null,
      "files",
      record("chat-a", [notes], 2), // another version
      record("chat-b", [notes]), // another chat's record under this key
      { version: 1, chatId: "chat-a", files: "notes" },
      record("chat-a", [ref]), // a history reference has no bytes to send
      record("chat-a", [{ ...picture, imageDeferred: true }]),
      record("chat-a", [{ ...picture, image: { mimeType: "image/png", data: "not base64!" } }]),
      record("chat-a", [notes, notes, notes, notes, notes]), // over the 4-file limit
      record("chat-a", [{ name: "a/b.md", text: "x" }]),
    ]) {
      expect(pendingChatRecordFiles(bad, "chat-a"), JSON.stringify(bad)).toBeNull();
    }
    expect(pendingChatRecordFiles(record("chat-a", [picture, paper]), "chat-a")).toEqual([picture, paper]);
    expect(pendingChatRecordFiles(record("chat-a", []), "chat-a")).toEqual([]);
  });

  it("keeps a record it cannot read: reads say so, writes refuse to replace it", async () => {
    const mem = memoryIdb();
    const store = pendingChatStore(mem.idb);
    await store.read("chat-a"); // creates the database
    const future = record("chat-a", [{ name: "x.md", text: "x", kind: "new" }], 2);
    mem.pending().set("chat-a", future);
    await expect(store.read("chat-a")).resolves.toEqual({ files: [], problem: "unreadable" });
    await expect(store.write("chat-a", [notes])).resolves.toBe("not_overwritten");
    await expect(store.write("chat-a", [])).resolves.toBe("not_overwritten");
    expect(mem.pending().get("chat-a")).toEqual(future);
    // A record of this format whose files fail the full check is the reader's call, not the
    // writer's: the chat that read it never writes until it is set aside.
    mem.pending().set("chat-b", record("chat-b", [{ name: "a/b.md", text: "x" }]));
    await expect(store.read("chat-b")).resolves.toEqual({ files: [], problem: "unreadable" });
  });

  it("sets an unreadable record aside whole, after which the chat saves again", async () => {
    const mem = memoryIdb();
    const store = pendingChatStore(mem.idb);
    await store.read("chat-a");
    const future = record("chat-a", [{ name: "x.md", text: "x" }], 2);
    mem.pending().set("chat-a", future);
    await expect(store.setAside("chat-a")).resolves.toBeUndefined();
    expect(mem.pending().has("chat-a")).toBe(false);
    const [kept] = [...mem.aside().values()] as { chatId: string; at: string; record: unknown }[];
    expect(kept).toMatchObject({ chatId: "chat-a", record: future });
    expect(Number.isNaN(Date.parse(kept?.at ?? ""))).toBe(false);
    await expect(store.write("chat-a", [notes])).resolves.toBeUndefined();
    await expect(store.read("chat-a")).resolves.toEqual({ files: [notes] });
    // Nothing to set aside is not a failure.
    await expect(store.setAside("chat-z")).resolves.toBeUndefined();
    expect(mem.aside().size).toBe(1);
  });

  it("says when storage failed, and a failed write leaves the earlier record whole", async () => {
    const mem = memoryIdb();
    const store = pendingChatStore(mem.idb);
    await store.write("chat-a", [notes]);
    mem.fail.commit = true;
    await expect(store.write("chat-a", [notes, paper])).resolves.toBe("not_saved");
    await expect(store.write("chat-a", [])).resolves.toBe("not_saved");
    mem.fail.commit = false;
    mem.fail.put = true; // e.g. a value the browser refuses to store
    await expect(store.write("chat-a", [notes, paper])).resolves.toBe("not_saved");
    mem.fail.put = false;
    mem.fail.get = true; // a write that cannot check what is there does not replace it
    await expect(store.write("chat-a", [paper])).resolves.toBe("not_saved");
    await expect(store.read("chat-a")).resolves.toEqual({ files: [], problem: "unavailable" });
    mem.fail.get = false;
    await expect(store.read("chat-a")).resolves.toEqual({ files: [notes] });
    for (const open of ["error", "throw", "blocked"] as const) {
      mem.fail.open = open;
      await expect(store.read("chat-a"), open).resolves.toEqual({ files: [], problem: "unavailable" });
      await expect(store.write("chat-a", [paper]), open).resolves.toBe("unavailable");
      await expect(store.setAside("chat-a"), open).resolves.toBe("unavailable");
    }
    mem.fail.open = undefined;
    await expect(store.read("chat-a")).resolves.toEqual({ files: [notes] });
  });

  it("without IndexedDB nothing is kept, and nothing throws", async () => {
    const store = pendingChatStore(undefined);
    await expect(store.read("chat-a")).resolves.toEqual({ files: [], problem: "unsupported" });
    await expect(store.write("chat-a", [notes])).resolves.toBe("unsupported");
    await expect(store.setAside("chat-a")).resolves.toBe("unsupported");
  });

  it("runs one chat's changes in order; waiting writes collapse into the newest list", async () => {
    const mem = memoryIdb();
    const store = pendingChatStore(mem.idb);
    await store.read("chat-a");
    const release = mem.hold();
    const first = store.write("chat-a", [notes]);
    await vi.waitFor(() => expect(mem.opening()).toBe(1)); // the first write is under way
    const second = store.write("chat-a", [notes, paper]);
    const third = store.write("chat-a", [paper]);
    release();
    await expect(Promise.all([first, second, third])).resolves.toEqual([undefined, undefined, undefined]);
    // The first ran as asked; the two that waited behind it were written once, as the newest.
    expect(mem.seen.commits).toBe(2);
    await expect(store.read("chat-a")).resolves.toEqual({ files: [paper] });
    // Asked together before any had started, they are one write.
    await Promise.all([store.write("chat-a", [notes]), store.write("chat-a", [picture])]);
    expect(mem.seen.commits).toBe(3);
    await expect(store.read("chat-a")).resolves.toEqual({ files: [picture] });
  });

  it("does not fold a write asked after a set-aside into one asked before it", async () => {
    const mem = memoryIdb();
    const store = pendingChatStore(mem.idb);
    await store.write("chat-a", [notes]);
    void store.write("chat-a", [paper]); // asked before the set-aside
    const aside = store.setAside("chat-a");
    const after = store.write("chat-a", [picture]);
    await expect(aside).resolves.toBeUndefined();
    await expect(after).resolves.toBeUndefined();
    expect([...mem.aside().values()]).toMatchObject([{ record: record("chat-a", [paper]) }]);
    await expect(store.read("chat-a")).resolves.toEqual({ files: [picture] });
  });
});
