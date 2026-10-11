import type { TerminalRecord } from "@herta/core";
import { describe, expect, it } from "vitest";
import {
  extractRecentDialogue,
  extractWorkingHistory,
  findLastDispatchBoundary,
} from "./backend-record-slices.js";

const doneMarker = (
  body: string,
  evidenceDetail?: string,
): TerminalRecord[number] => ({
  kind: "system",
  label: "差分协处理器",
  body,
  role: "done-marker",
  ...(evidenceDetail !== undefined ? { evidenceDetail } : {}),
});

describe("findLastDispatchBoundary", () => {
  it("returns -1 when there is no terminal marker", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "hi" },
      { kind: "herta", surface: "speech", text: "@板砖 go" },
    ];
    expect(findLastDispatchBoundary(record)).toBe(-1);
  });

  it("returns the index of the LAST done- or noop-marker", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "a" },
      doneMarker("完成 · 1 file"),
      { kind: "user", text: "b" },
      {
        kind: "system",
        label: "差分协处理器",
        body: "无产出",
        role: "noop-marker",
      },
      { kind: "herta", surface: "speech", text: "@板砖 c" },
    ];
    expect(findLastDispatchBoundary(record)).toBe(3);
  });
});

describe("extractRecentDialogue", () => {
  it("renders the interleaved user+Herta speech AFTER the boundary", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "old" },
      doneMarker("完成 · 1 file"),
      { kind: "herta", surface: "speech", text: "要我加缓存吗？" },
      { kind: "user", text: "好" },
      { kind: "herta", surface: "speech", text: "@板砖 加缓存" },
    ];
    const out = extractRecentDialogue(record, 1);
    expect(out).toBe(
      "黑塔：要我加缓存吗？\n\n开拓者：好\n\n黑塔：@板砖 加缓存",
    );
  });

  it("excludes Herta thoughts and system blocks", () => {
    const record: TerminalRecord = [
      { kind: "herta", surface: "thought", text: "（盘算）" },
      { kind: "system", label: "系统", body: "→ read" },
      { kind: "user", text: "do it" },
    ];
    expect(extractRecentDialogue(record, -1)).toBe("开拓者：do it");
  });

  it("returns empty string when there is nothing after the boundary", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "x" },
      doneMarker("完成"),
    ];
    expect(extractRecentDialogue(record, 1)).toBe("");
  });

  it("keeps only the last 8 speech blocks", () => {
    const record: TerminalRecord = Array.from({ length: 12 }, (_, i) => ({
      kind: "user" as const,
      text: `u${i}`,
    }));
    const out = extractRecentDialogue(record, -1);
    expect(out).toContain("开拓者：u11");
    expect(out).toContain("开拓者：u4");
    expect(out).not.toContain("开拓者：u3");
  });
});

describe("extractWorkingHistory", () => {
  it("includes done-markers THROUGH the boundary, with body + evidenceDetail", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "a" },
      doneMarker("完成 · 1 file", "↳ 改动文件: auth.ts"),
      { kind: "herta", surface: "speech", text: "@板砖 b" },
    ];
    const out = extractWorkingHistory(record, 1);
    expect(out).toBe("完成 · 1 file\n↳ 改动文件: auth.ts");
  });

  it("excludes noop-markers and returns empty when no done-marker", () => {
    const record: TerminalRecord = [
      {
        kind: "system",
        label: "差分协处理器",
        body: "无产出",
        role: "noop-marker",
      },
    ];
    expect(extractWorkingHistory(record, 0)).toBe("");
  });

  it("scans the whole record when boundary is -1 (first dispatch → empty)", () => {
    const record: TerminalRecord = [{ kind: "user", text: "first task" }];
    expect(extractWorkingHistory(record, -1)).toBe("");
  });

  it("keeps only the last 3 done-markers", () => {
    const record: TerminalRecord = [
      doneMarker("第1"),
      doneMarker("第2"),
      doneMarker("第3"),
      doneMarker("第4"),
    ];
    const out = extractWorkingHistory(record, 3);
    expect(out).toContain("第4");
    expect(out).toContain("第2");
    expect(out).not.toContain("第1");
  });
});
