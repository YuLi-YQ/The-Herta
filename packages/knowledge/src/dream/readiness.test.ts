import type { TerminalRecord, TerminalRecordBlock } from "@herta/core";
import { describe, expect, it } from "vitest";
import {
  countHertaTurns,
  hasEnoughMaterial,
  isModifiedSince,
} from "./readiness.js";

function sessionWithHertaTurns(n: number): TerminalRecord {
  const blocks: TerminalRecordBlock[] = [{ kind: "user", text: "hi" }];
  for (let i = 0; i < n; i++) {
    blocks.push({ kind: "herta", surface: "speech", text: `line ${i}` });
  }
  return blocks;
}

describe("countHertaTurns", () => {
  it("counts only 黑塔 speech/thought blocks, not user or system", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "q" },
      { kind: "herta", surface: "speech", text: "a" },
      { kind: "herta", surface: "thought", text: "（我 想）" },
      { kind: "system", label: "系统", body: "Writing foo.ts" },
      { kind: "herta", surface: "speech", text: "b" },
    ];
    expect(countHertaTurns(record)).toBe(3);
  });

  it("returns 0 for a record with no 黑塔 blocks", () => {
    expect(
      countHertaTurns([
        { kind: "user", text: "q" },
        { kind: "system", label: "系统", body: "noop" },
      ]),
    ).toBe(0);
  });
});

describe("hasEnoughMaterial", () => {
  const thresholds = { minNewSessions: 5, minSessionHertaTurns: 25 };

  it("fires when the new-session count reaches minNewSessions", () => {
    const records = Array.from({ length: 5 }, () => sessionWithHertaTurns(1));
    expect(hasEnoughMaterial(records, thresholds)).toBe(true);
  });

  it("fires on a single long-enough session even with few sessions", () => {
    expect(hasEnoughMaterial([sessionWithHertaTurns(25)], thresholds)).toBe(
      true,
    );
  });

  it("does not fire when neither branch is satisfied", () => {
    // 4 sessions (< 5) and none reaches 25 黑塔 turns.
    const records = Array.from({ length: 4 }, () => sessionWithHertaTurns(10));
    expect(hasEnoughMaterial(records, thresholds)).toBe(false);
  });

  it("does not fire on an empty new-session set", () => {
    expect(hasEnoughMaterial([], thresholds)).toBe(false);
  });

  it("counts a long session's turns SINCE the last pass — one touch never re-qualifies its whole history (dream review 2026-09-22, finding 11)", () => {
    const anchor = Date.parse("2026-09-15T00:00:00Z");
    const old = "2026-09-01T10:00:00Z";
    const fresh = "2026-09-20T10:00:00Z";
    const weeksOld: TerminalRecordBlock[] = [{ kind: "user", text: "hi" }];
    for (let i = 0; i < 40; i++) {
      weeksOld.push({
        kind: "herta",
        surface: "speech",
        text: `l${i}`,
        at: old,
      });
    }
    // One new exchange since the pass: the file is "modified since".
    weeksOld.push({ kind: "user", text: "again", at: fresh });
    weeksOld.push({ kind: "herta", surface: "speech", text: "嗯", at: fresh });
    expect(countHertaTurns(weeksOld)).toBe(41);
    expect(countHertaTurns(weeksOld, anchor)).toBe(1);
    expect(hasEnoughMaterial([weeksOld], thresholds, anchor)).toBe(false);
    // Unstamped blocks predate stamping: old by definition.
    expect(countHertaTurns(sessionWithHertaTurns(30), anchor)).toBe(0);
  });

  it("uses the exact boundary: exactly minSessionHertaTurns qualifies", () => {
    expect(hasEnoughMaterial([sessionWithHertaTurns(24)], thresholds)).toBe(
      false,
    );
    expect(hasEnoughMaterial([sessionWithHertaTurns(25)], thresholds)).toBe(
      true,
    );
  });
});

describe("isModifiedSince", () => {
  const since = Date.parse("2026-06-10T00:00:00.000Z");

  it("is true for a timestamp strictly after the anchor", () => {
    expect(isModifiedSince("2026-06-15T00:00:00.000Z", since)).toBe(true);
  });

  it("is false at the exact boundary (<= anchor is not 'modified since')", () => {
    expect(isModifiedSince("2026-06-10T00:00:00.000Z", since)).toBe(false);
  });

  it("is false for a timestamp before the anchor", () => {
    expect(isModifiedSince("2026-06-05T00:00:00.000Z", since)).toBe(false);
  });

  it("is false for an unparseable timestamp (NaN guard)", () => {
    expect(isModifiedSince("not-a-date", since)).toBe(false);
    expect(isModifiedSince("", since)).toBe(false);
  });

  it("counts every parseable session as new when the anchor is 0 (never run)", () => {
    expect(isModifiedSince("2020-01-01T00:00:00.000Z", 0)).toBe(true);
    // …but an unparseable one is still excluded.
    expect(isModifiedSince("nope", 0)).toBe(false);
  });
});
