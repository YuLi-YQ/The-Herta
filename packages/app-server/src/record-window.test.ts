import type { TerminalRecord } from "@herta/core";
import { describe, expect, it } from "vitest";
import { RECORD_TAIL_BLOCKS, recordTail } from "./record-window.js";

function blocks(n: number): TerminalRecord {
  return Array.from({ length: n }, (_, i) => ({
    kind: "user" as const,
    text: `m${i}`,
  }));
}

describe("recordTail", () => {
  it("returns a short record whole, start 0 (same reference)", () => {
    const r = blocks(3);
    const tail = recordTail(r, 10);
    expect(tail.start).toBe(0);
    expect(tail.record).toBe(r);
  });

  it("slices the trailing window with its absolute start", () => {
    const r = blocks(7);
    const tail = recordTail(r, 3);
    expect(tail.start).toBe(4);
    expect(tail.record.map((b) => (b.kind === "user" ? b.text : ""))).toEqual([
      "m4",
      "m5",
      "m6",
    ]);
  });

  it("a record exactly at the bound is whole", () => {
    const r = blocks(5);
    expect(recordTail(r, 5)).toEqual({ record: r, start: 0 });
  });

  it("defaults to RECORD_TAIL_BLOCKS", () => {
    const r = blocks(RECORD_TAIL_BLOCKS + 10);
    const tail = recordTail(r);
    expect(tail.start).toBe(10);
    expect(tail.record).toHaveLength(RECORD_TAIL_BLOCKS);
  });
});
