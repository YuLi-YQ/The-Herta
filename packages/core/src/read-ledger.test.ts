import { describe, expect, it } from "vitest";
import { ReadLedger } from "./read-ledger.js";

describe("ReadLedger", () => {
  it("returns undefined for unknown paths", () => {
    const l = new ReadLedger();
    expect(l.get("/some/path")).toBeUndefined();
  });

  it("records and retrieves a sha by absolute path", () => {
    const l = new ReadLedger();
    const at = new Date("2026-05-03T00:00:00Z");
    l.record("/tmp/a.txt", "abc123", at);
    const got = l.get("/tmp/a.txt");
    expect(got).toBeDefined();
    expect(got?.sha256).toBe("abc123");
    expect(got?.atTs).toEqual(at);
  });

  it("uses current time when atTs omitted", () => {
    const l = new ReadLedger();
    const before = new Date();
    l.record("/tmp/a.txt", "abc123");
    const after = new Date();
    const got = l.get("/tmp/a.txt");
    expect(got).toBeDefined();
    expect(got?.atTs.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(got?.atTs.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("overwrites prior record for the same path", () => {
    const l = new ReadLedger();
    l.record("/tmp/a.txt", "first");
    l.record("/tmp/a.txt", "second");
    expect(l.get("/tmp/a.txt")?.sha256).toBe("second");
  });

  it("keeps records for distinct paths independent", () => {
    const l = new ReadLedger();
    l.record("/tmp/a.txt", "AAA");
    l.record("/tmp/b.txt", "BBB");
    expect(l.get("/tmp/a.txt")?.sha256).toBe("AAA");
    expect(l.get("/tmp/b.txt")?.sha256).toBe("BBB");
  });

  it("clear(path) wipes only that path", () => {
    const l = new ReadLedger();
    l.record("/tmp/a.txt", "AAA");
    l.record("/tmp/b.txt", "BBB");
    l.clear("/tmp/a.txt");
    expect(l.get("/tmp/a.txt")).toBeUndefined();
    expect(l.get("/tmp/b.txt")?.sha256).toBe("BBB");
  });

  it("clear() with no arg wipes all", () => {
    const l = new ReadLedger();
    l.record("/tmp/a.txt", "AAA");
    l.record("/tmp/b.txt", "BBB");
    l.clear();
    expect(l.get("/tmp/a.txt")).toBeUndefined();
    expect(l.get("/tmp/b.txt")).toBeUndefined();
  });
});
