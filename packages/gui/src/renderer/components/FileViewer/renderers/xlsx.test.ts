import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  columnIndex,
  columnLetters,
  dateKindOfFormat,
  formatNumber,
  formatSerial,
  MAX_SHEET_COLS,
  MAX_SHEET_ROWS,
  parseWorkbook,
} from "./xlsx.js";

// import.meta.dirname, not a file URL: under the jsdom environment
// import.meta.url is the page's origin, which readFileSync refuses.
const fixture = new Uint8Array(
  readFileSync(join(import.meta.dirname, "__fixtures__", "fixture.xlsx")),
);

describe("xlsx reader (ADR 0054 §4) — an openpyxl-written workbook", () => {
  const wb = parseWorkbook(fixture);
  const sales = wb.sheets[0];

  it("lists the sheets in workbook order, empty ones included", () => {
    expect(wb.sheets.map((s) => s.name)).toEqual(["Sales", "Empty", "Wide"]);
    expect(wb.sheets[1]?.rowCount).toBe(0);
    expect(wb.sheets[2]?.colCount).toBe(30);
    expect(wb.sheets[2]?.rowCount).toBe(3);
    expect(wb.sheets[2]?.rows[2]?.[29]?.text).toBe("r3c30");
  });

  it("reads shared strings (CJK included), numbers without float noise, booleans, and dates by style", () => {
    expect(sales?.rows[0]?.map((c) => c?.text)).toEqual([
      "Region",
      "Units",
      "Price",
      "Date",
      "Ok",
      "Note",
    ]);
    const r1 = sales?.rows[1]?.map((c) => c?.text);
    expect(r1).toEqual(["North", "12", "3.5", "2026-09-03", "TRUE", "plain"]);
    const r2 = sales?.rows[2]?.map((c) => c?.text);
    expect(r2?.[0]).toBe("South 南区");
    expect(r2?.[2]).toBe("0.3"); // 0.1 + 0.2 — no 0.30000000000000004
    expect(r2?.[3]).toBe("2026-01-02 13:45:00");
    expect(r2?.[4]).toBe("FALSE");
    expect(r2?.[5]).toBe("mixed 中文");
    expect(sales?.rows[3]?.[1]?.text).toBe("1000000");
    expect(sales?.rows[3]?.[2]?.text).toBe("1234567.891");
    expect(sales?.rows[3]?.[3]?.text).toBe("1999-12-31");
    expect(sales?.rows[1]?.[1]?.type).toBe("n");
    expect(sales?.rows[1]?.[3]?.type).toBe("d");
    expect(sales?.rows[1]?.[4]?.type).toBe("b");
  });

  it("a formula without a cached value shows nothing rather than the formula text", () => {
    const cell = sales?.rows[4]?.[1];
    expect(cell === undefined || cell.text === "").toBe(true);
  });

  it("custom number formats: a percent is a number, a date format is a date, a time format is a time", () => {
    expect(sales?.rows[7]?.[3]?.text).toBe("0.5");
    expect(sales?.rows[7]?.[4]?.text).toBe("2023-03-15");
    expect(sales?.rows[7]?.[5]?.text).toBe("18:00:00");
  });

  it("carries merged ranges and column widths for the grid", () => {
    expect(sales?.merges).toContainEqual({ r1: 6, c1: 0, r2: 6, c2: 2 });
    expect(sales?.rows[6]?.[0]?.text).toBe("merged title");
    expect(sales?.colWidths[0]).toBe(18 * 7 + 5);
    expect(sales?.colWidths[5]).toBe(30 * 7 + 5);
    expect(sales?.colWidths[1]).toBeUndefined();
  });
});

describe("xlsx reader — bounds and helpers", () => {
  it("column letters round-trip", () => {
    expect(columnLetters(0)).toBe("A");
    expect(columnLetters(25)).toBe("Z");
    expect(columnLetters(26)).toBe("AA");
    expect(columnLetters(701)).toBe("ZZ");
    expect(columnIndex("AA")).toBe(26);
    expect(columnIndex("zz")).toBe(701);
    expect(columnIndex("A1")).toBe(-1);
  });

  it("judges format codes: date letters outside quotes and brackets", () => {
    expect(dateKindOfFormat("yyyy-mm-dd")).toBe("date");
    expect(dateKindOfFormat("h:mm:ss")).toBe("time");
    expect(dateKindOfFormat("yyyy-mm-dd h:mm")).toBe("datetime");
    expect(dateKindOfFormat("0.00%")).toBeNull();
    expect(dateKindOfFormat("#,##0.00")).toBeNull();
    expect(dateKindOfFormat("General")).toBeNull();
    expect(dateKindOfFormat('"Day: "0')).toBeNull();
    expect(dateKindOfFormat("[Red]0.0")).toBeNull();
    expect(dateKindOfFormat("[$-409]mmm d, yyyy")).toBe("date");
    expect(dateKindOfFormat("@")).toBeNull();
  });

  it("formats serials on both epochs", () => {
    expect(formatSerial(45000, "date", false)).toBe("2023-03-15");
    expect(formatSerial(0.75, "time", false)).toBe("18:00:00");
    expect(formatSerial(1, "date", true)).toBe("1904-01-02");
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatNumber(1e21)).toBe("1e+21");
  });

  it("caps rows and columns and says so", () => {
    const rows: string[] = [];
    for (let r = 1; r <= MAX_SHEET_ROWS + 3; r++) {
      rows.push(`<row r="${r}"><c r="A${r}"><v>${r}</v></c></row>`);
    }
    const wideCells: string[] = [];
    for (let c = 0; c < MAX_SHEET_COLS + 2; c++) {
      wideCells.push(`<c r="${columnLetters(c)}1"><v>${c}</v></c>`);
    }
    const pkg = zipSync({
      "xl/workbook.xml": strToU8(
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Tall" sheetId="1" r:id="rId1"/><sheet name="Wide" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
      ),
      "xl/worksheets/sheet1.xml": strToU8(
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join("")}</sheetData></worksheet>`,
      ),
      "xl/worksheets/sheet2.xml": strToU8(
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${wideCells.join("")}</row></sheetData></worksheet>`,
      ),
    });
    const wb = parseWorkbook(pkg);
    expect(wb.sheets[0]?.rowCount).toBe(MAX_SHEET_ROWS);
    expect(wb.sheets[0]?.rowsCapped).toBe(true);
    expect(wb.sheets[1]?.colCount).toBe(MAX_SHEET_COLS);
    expect(wb.sheets[1]?.colsCapped).toBe(true);
  });

  it("refuses a package that is not a workbook", () => {
    const pkg = zipSync({ "hello.txt": strToU8("hi") });
    expect(() => parseWorkbook(pkg)).toThrow();
  });
});
