import { beforeEach, describe, expect, it, vi } from "vitest";
import { readPendingDocs, writePendingDocs } from "./pending-documents.js";
const doc = { id: "one", path: "C:\\test\\spec.md", name: "spec.md" };
beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
describe("pending document storage", () => {
  it("keeps queues isolated and persists removal", () => {
    expect(writePendingDocs("a", [doc])).toBeUndefined();
    expect(readPendingDocs("b").docs).toEqual([]);
    expect(readPendingDocs("a").docs).toEqual([doc]);
    expect(writePendingDocs("a", [])).toBeUndefined();
    expect(readPendingDocs("a").docs).toEqual([]);
  });
  it.each(["broken json", JSON.stringify([{ ...doc, path: 3 }]), JSON.stringify([doc, doc])])("preserves invalid original data: %s", raw => {
    const key = "the-herta.pending-documents.v1.a";
    localStorage.setItem(key, raw);
    expect(readPendingDocs("a").error).toBeTruthy();
    expect(writePendingDocs("a", [doc])).toBeTruthy();
    expect(localStorage.getItem(key)).toBe(raw);
  });
  it("reports quota failure and preserves the previous queue", () => {
    writePendingDocs("a", [doc]);
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(writePendingDocs("a", [{ ...doc, id: "new" }])).toBeTruthy();
    spy.mockRestore();
    expect(readPendingDocs("a").docs).toEqual([doc]);
  });
  it("reports inaccessible storage without trying to overwrite it", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(readPendingDocs("a").error).toBeTruthy();
    expect(writePendingDocs("a", [doc])).toBeTruthy();
    expect(write).not.toHaveBeenCalled();
  });
});
