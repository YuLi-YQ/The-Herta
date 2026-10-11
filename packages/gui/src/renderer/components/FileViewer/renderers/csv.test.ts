import { describe, expect, it } from "vitest";
import { detectDelimiter, MAX_CSV_ROWS, parseCsv } from "./csv.js";

describe("parseCsv (ADR 0054 §4)", () => {
  it("splits rows and fields, honoring quotes, doubled quotes and embedded newlines", () => {
    const t = parseCsv('a,b,c\n1,"x, y","say ""hi"""\n2,"multi\nline",3\n');
    expect(t.rows).toEqual([
      ["a", "b", "c"],
      ["1", "x, y", 'say "hi"'],
      ["2", "multi\nline", "3"],
    ]);
    expect(t.cols).toBe(3);
    expect(t.capped).toBe(false);
    expect(t.delimiter).toBe(",");
  });

  it("picks the delimiter from the first line — tab, semicolon, comma", () => {
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
    expect(detectDelimiter("a;b;c")).toBe(";");
    expect(detectDelimiter("a,b")).toBe(",");
    expect(parseCsv("x\ty\n1\t2\n").rows).toEqual([
      ["x", "y"],
      ["1", "2"],
    ]);
  });

  it("sheds a BOM, accepts CRLF and lone CR, and does not invent a row from the trailing newline", () => {
    const t = parseCsv("﻿a,b\r\n1,2\r3,4\n");
    expect(t.rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("keeps a ragged table's widest row as the column count", () => {
    expect(parseCsv("a\n1,2,3\nx,y\n").cols).toBe(3);
  });

  it("caps at MAX_CSV_ROWS and says so", () => {
    const big = Array.from(
      { length: MAX_CSV_ROWS + 5 },
      (_, i) => `r${i}`,
    ).join("\n");
    const t = parseCsv(big);
    expect(t.rows).toHaveLength(MAX_CSV_ROWS);
    expect(t.capped).toBe(true);
  });
});
