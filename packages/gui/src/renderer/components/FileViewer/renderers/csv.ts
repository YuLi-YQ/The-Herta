/**
 * CSV / TSV → rows (ADR 0054 §4). RFC 4180 quoting (doubled quotes,
 * newlines inside quotes), the delimiter picked from the first line
 * (tab, then semicolon, then comma — whichever splits it most), CR/LF
 * tolerant, BOM shed. Bounded: past MAX_ROWS the rest is dropped and
 * `capped` says so.
 */
export const MAX_CSV_ROWS = 50_000;

export interface CsvTable {
  readonly rows: readonly (readonly string[])[];
  readonly cols: number;
  readonly capped: boolean;
  readonly delimiter: string;
}

export function detectDelimiter(firstLine: string): string {
  // Comma unless another delimiter actually appears — a one-column first
  // line must not pick the tab by default.
  let best = ",";
  let bestCount = 0;
  for (const d of ["\t", ";", ","]) {
    const n = firstLine.split(d).length - 1;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

export function parseCsv(text: string, delimiter?: string): CsvTable {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const firstNl = src.indexOf("\n");
  const d =
    delimiter ?? detectDelimiter(firstNl < 0 ? src : src.slice(0, firstNl));
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let capped = false;
  let cols = 0;
  const pushRow = (): boolean => {
    row.push(field);
    field = "";
    if (rows.length >= MAX_CSV_ROWS) {
      capped = true;
      return false;
    }
    rows.push(row);
    if (row.length > cols) cols = row.length;
    row = [];
    return true;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field.length === 0) {
      quoted = true;
    } else if (ch === d) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      if (!pushRow()) break;
    } else if (ch === "\r") {
      // CRLF or lone CR both end the row.
      if (src[i + 1] === "\n") i++;
      if (!pushRow()) break;
    } else field += ch;
  }
  // A last row without a trailing newline; a trailing newline leaves an
  // empty field which is NOT a row.
  if (!capped && (field.length > 0 || row.length > 0)) pushRow();
  return { rows, cols, capped, delimiter: d };
}
