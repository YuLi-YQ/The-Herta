import { describe, expect, it } from "vitest";
import { chunkDocument, pageOfMarkerLine } from "./chunker.js";

const pg = (n: number): string => `── 第 ${n} 页 ──`;

describe("chunkDocument (ADR 0043)", () => {
  it("recognises both page-marker shapes and nothing else", () => {
    expect(pageOfMarkerLine("── 第 12 页 ──")).toBe(12);
    expect(pageOfMarkerLine("── page 7 ──")).toBe(7);
    expect(pageOfMarkerLine("第 12 页")).toBeUndefined();
    expect(pageOfMarkerLine("── 第 12 页 ── 后面还有字")).toBeUndefined();
  });

  it("a short text is one chunk covering every line, with no page span when unmarked", () => {
    const out = chunkDocument("a\nb\nc\n");
    expect(out).toEqual([{ fromLine: 1, toLine: 3, text: "a\nb\nc" }]);
  });

  it("cuts at the LAST page marker that leaves the chunk at least half full, and the next chunk starts on that marker", () => {
    // 5 pages of 100 chars each (marker line + one 99-char line); budget 250
    // → ~2.4 pages per chunk → the cut lands on page boundaries.
    const page = (n: number) => `${pg(n)}\n${"x".repeat(99)}`;
    const text = [1, 2, 3, 4, 5].map(page).join("\n\n");
    const out = chunkDocument(text, { targetChars: 250 });
    // Lines: marker, text, blank per page → page n's marker is line 3n-2.
    expect(out.map((c) => [c.fromLine, c.toLine, c.pages])).toEqual([
      [1, 6, [1, 2]], // pages 1–2, incl. the blank line before page 3's marker
      [7, 12, [3, 4]],
      [13, 14, [5, 5]],
    ]);
    for (const c of out.slice(0, -1)) {
      expect(c.text.length).toBeLessThanOrEqual(250);
      expect(c.text.length * 2).toBeGreaterThanOrEqual(250);
    }
    // Every chunk but the first starts ON a marker line.
    expect(out[1]?.text.startsWith(pg(3))).toBe(true);
    expect(out[2]?.text.startsWith(pg(5))).toBe(true);
    // Ranges tile the file exactly.
    expect(out[out.length - 1]?.toLine).toBe(text.split("\n").length);
  });

  it("without markers it cuts at a blank line; without one it hard-cuts at the budget", () => {
    const para = "y".repeat(80);
    const text = [para, para, para, para].join("\n\n"); // 4 paragraphs
    const out = chunkDocument(text, { targetChars: 200 });
    expect(out.map((c) => [c.fromLine, c.toLine])).toEqual([
      [1, 4], // two paragraphs + the blank after the second
      [5, 7],
    ]);
    expect(out[0]?.pages).toBeUndefined();
    const wall = "z".repeat(1000);
    const hard = chunkDocument(wall, { targetChars: 300 });
    expect(hard).toEqual([{ fromLine: 1, toLine: 1, text: wall }]);
    const lines = Array.from({ length: 10 }, () => "q".repeat(50)).join("\n");
    const cut = chunkDocument(lines, { targetChars: 160 });
    // 51 chars per line incl. newline: the 4th line crosses the budget and
    // a hard cut lands right after it (the budget is a target, not a cap).
    expect(cut.map((c) => [c.fromLine, c.toLine])).toEqual([
      [1, 4],
      [5, 8],
      [9, 10],
    ]);
  });

  it("a chunk that starts before the first marker still reports the first page it touches", () => {
    const text = `title\nintro\n\n${pg(1)}\nbody\n${pg(2)}\nmore`;
    const [only] = chunkDocument(text);
    expect(only?.pages).toEqual([1, 2]);
  });

  it("is deterministic and tiles the file without gaps or overlaps", () => {
    const text = Array.from({ length: 400 }, (_, i) =>
      i % 37 === 0
        ? pg(i / 37 + 1)
        : i % 11 === 0
          ? ""
          : `line ${i} ${"w".repeat(i % 23)}`,
    ).join("\n");
    const a = chunkDocument(text, { targetChars: 900 });
    const b = chunkDocument(text, { targetChars: 900 });
    expect(a).toEqual(b);
    let next = 1;
    for (const c of a) {
      expect(c.fromLine).toBe(next);
      expect(c.toLine).toBeGreaterThanOrEqual(c.fromLine);
      next = c.toLine + 1;
    }
    expect(next - 1).toBe(400);
    expect(a.map((c) => c.text).join("\n")).toBe(text);
  });
});
