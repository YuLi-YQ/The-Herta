import { beforeEach, describe, expect, it, vi } from "vitest";
import { readAttachIssues, writeAttachIssues } from "./pending-attach-issues.js";
const refused = { id: "one", path: "C:\\test\\keys.png", name: "keys.png", error: "refused" };
const reading = { id: "two", path: "C:\\test\\big.pdf", name: "big.pdf" };
const pasted = { id: "three", name: "pasted-image.png", error: "refused" };
const key = "the-herta.pending-attach-issues.v1.a";
beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
describe("R99 composer attachment issue storage", () => {
  it("keeps tasks apart, stores no bytes, and removes the record when empty", () => {
    const carrying = { ...pasted, bytes: new Uint8Array([1, 2, 3]) } as typeof pasted;
    expect(writeAttachIssues("a", [refused, reading, carrying])).toBeUndefined();
    expect(readAttachIssues("b").issues).toEqual([]);
    expect(readAttachIssues("a").issues).toEqual([refused, reading, pasted]);
    expect(localStorage.getItem(key)).not.toMatch(/bytes/);
    expect(writeAttachIssues("a", [])).toBeUndefined();
    expect(localStorage.getItem(key)).toBeNull();
  });
  it.each([
    "broken json",
    JSON.stringify([{ ...refused, path: 3 }]),
    JSON.stringify([refused, refused]),
    JSON.stringify([{ ...pasted, name: "" }]),
    JSON.stringify([{ ...refused, error: "x".repeat(2001) }]),
  ])("preserves invalid original data: %s", (raw) => {
    localStorage.setItem(key, raw);
    expect(readAttachIssues("a").error).toBe("unreadable");
    expect(writeAttachIssues("a", [refused])).toBe("not_overwritten");
    expect(localStorage.getItem(key)).toBe(raw);
  });
  it("reports a quota failure and keeps the previous record", () => {
    writeAttachIssues("a", [refused]);
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(writeAttachIssues("a", [refused, reading])).toBe("not_saved");
    spy.mockRestore();
    expect(readAttachIssues("a").issues).toEqual([refused]);
  });
  it("reports inaccessible storage without trying to overwrite it", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(readAttachIssues("a").error).toBe("unreadable");
    expect(writeAttachIssues("a", [refused])).toBe("not_overwritten");
    expect(write).not.toHaveBeenCalled();
  });
});
describe("R102 the independent chat's cards", () => {
  const chatKey = "the-herta.chat-attach-issues.v1.a";
  it("keeps a chat's cards under its own key, apart from a task with the same id", () => {
    expect(writeAttachIssues("a", [pasted], "chat")).toBeUndefined();
    expect(localStorage.getItem(chatKey)).toBe(JSON.stringify([pasted]));
    expect(localStorage.getItem(key)).toBeNull();
    expect(readAttachIssues("a").issues).toEqual([]);
    expect(writeAttachIssues("a", [refused])).toBeUndefined();
    expect(readAttachIssues("a", "chat").issues).toEqual([pasted]);
    // An unreadable record of one never blocks the other.
    localStorage.setItem(key, "broken");
    expect(writeAttachIssues("a", [], "chat")).toBeUndefined();
    expect(localStorage.getItem(chatKey)).toBeNull();
    expect(localStorage.getItem(key)).toBe("broken");
    localStorage.setItem(chatKey, "broken");
    expect(readAttachIssues("a", "chat").error).toBe("unreadable");
    expect(writeAttachIssues("a", [pasted], "chat")).toBe("not_overwritten");
    expect(localStorage.getItem(chatKey)).toBe("broken");
  });
});
