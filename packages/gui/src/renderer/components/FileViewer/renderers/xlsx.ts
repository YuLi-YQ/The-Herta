import {
  attr,
  attrNum,
  child,
  children,
  decodeEntities,
  descendants,
  type OoxmlPackage,
  openPackage,
  partText,
  partXml,
  relId,
  relsFor,
} from "./ooxml.js";

/**
 * A workbook reader for the viewer (ADR 0054 §4): sheet order and names
 * from workbook.xml, cells from each sheet's sheetData, shared and inline
 * strings, cached formula values, booleans, errors — and the one
 * formatting question that changes what a number MEANS: is the cell's
 * style a date/time? Everything else (fonts, fills, borders) is the
 * spreadsheet's dress, not its content, and the grid draws its own.
 *
 * The small parts (workbook, rels, styles) go through the DOM. The big
 * ones — sheetData and the shared-string table — are scanned with
 * regexes over the XML text: a 200k-cell sheet is a few hundred
 * milliseconds that way and seconds (and a frozen renderer) as a DOM.
 * The grammar is narrow and regular (rows of cells of one value), which
 * is what makes a scanner honest here.
 *
 * Bounded: rows and columns per sheet, and the raw XML size of a sheet,
 * so a million-cell export shows its head and says so.
 */
export const MAX_SHEET_ROWS = 10_000;
export const MAX_SHEET_COLS = 256;
/** Sheet XML above this is not scanned at all — the panel says so. */
export const MAX_SHEET_XML_CHARS = 48_000_000;

export type CellType = "n" | "s" | "b" | "e" | "d" | "t";

export interface Cell {
  /** Display text — already formatted for the grid. */
  readonly text: string;
  readonly type: CellType;
}

export interface Merge {
  readonly r1: number;
  readonly c1: number;
  readonly r2: number;
  readonly c2: number;
}

export interface Sheet {
  readonly name: string;
  /** Row-major, sparse: `rows[r][c]` may be undefined. */
  readonly rows: readonly (readonly (Cell | undefined)[])[];
  readonly rowCount: number;
  readonly colCount: number;
  /** Column widths in px by column index (undefined = default). */
  readonly colWidths: readonly (number | undefined)[];
  readonly merges: readonly Merge[];
  readonly rowsCapped: boolean;
  readonly colsCapped: boolean;
  /** The sheet was too large to parse at all. */
  readonly skipped: boolean;
}

export interface Workbook {
  readonly sheets: readonly Sheet[];
}

const WORKSHEET_REL = "worksheet";

/** `A` → 0, `Z` → 25, `AA` → 26. */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const v = ch.charCodeAt(0) - 64;
    if (v < 1 || v > 26) return -1;
    n = n * 26 + v;
  }
  return n - 1;
}

/** 0 → `A`, 25 → `Z`, 26 → `AA`. */
export function columnLetters(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseRef(ref: string): { r: number; c: number } | null {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref);
  if (m === null) return null;
  const c = columnIndex(m[1] as string);
  const r = Number.parseInt(m[2] as string, 10) - 1;
  return c < 0 || r < 0 ? null : { r, c };
}

// ---- number formats ---------------------------------------------------------

/** Built-in numFmtIds that are dates/times (ECMA-376 §18.8.30). 27–36 and
 *  50–58 are the East-Asian date variants. */
const BUILTIN_DATE_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);
const BUILTIN_TIME_ONLY_IDS = new Set([18, 19, 20, 21, 45, 46, 47]);

type DateKind = "date" | "time" | "datetime" | null;

/** Judge a custom format code: date letters outside quotes / brackets /
 *  escapes mean a date; hours-minutes-seconds only means a time. */
export function dateKindOfFormat(code: string): DateKind {
  const stripped = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "")
    .replace(/_./g, "")
    .replace(/\*./g, "")
    .toLowerCase();
  if (stripped === "general" || stripped.includes("@")) return null;
  // `m` is a month beside d/y and a minute beside h/s; alone it is a month.
  const dayYear = /[dy]/.test(stripped);
  const hourSec = /[hs]/.test(stripped);
  const month = /(^|[^a])m/.test(stripped);
  if (dayYear && hourSec) return "datetime";
  if (dayYear) return "date";
  if (hourSec) return "time";
  if (month) return "date";
  return null;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** Excel serial → display. `date1904` selects the Mac epoch. */
export function formatSerial(
  serial: number,
  kind: Exclude<DateKind, null>,
  date1904: boolean,
): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = epoch + serial * 86_400_000;
  const d = new Date(Math.round(ms / 1000) * 1000);
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const hms = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (kind === "date") return ymd;
  if (kind === "time") return hms;
  return `${ymd} ${hms}`;
}

/** A number as the grid shows it: no float noise, no exponent for the
 *  common magnitudes. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return Number(n.toPrecision(15)).toString();
}

interface Styles {
  /** Per cellXfs index: the date kind, or null. */
  readonly dateKinds: readonly DateKind[];
}

function readStyles(pkg: OoxmlPackage, stylesPath: string | null): Styles {
  if (stylesPath === null) return { dateKinds: [] };
  const doc = partXml(pkg, stylesPath);
  if (doc === null) return { dateKinds: [] };
  const custom = new Map<number, string>();
  for (const f of descendants(doc, "numFmt")) {
    const id = attrNum(f, "numFmtId");
    const code = attr(f, "formatCode");
    if (id !== null && code !== null) custom.set(id, code);
  }
  const xfs = child(doc.documentElement, "cellXfs");
  if (xfs === null) return { dateKinds: [] };
  const kinds: DateKind[] = [];
  for (const xf of children(xfs, "xf")) {
    const id = attrNum(xf, "numFmtId") ?? 0;
    const code = custom.get(id);
    if (code !== undefined) kinds.push(dateKindOfFormat(code));
    else if (BUILTIN_TIME_ONLY_IDS.has(id)) kinds.push("time");
    else if (id === 22) kinds.push("datetime");
    else if (BUILTIN_DATE_IDS.has(id)) kinds.push("date");
    else kinds.push(null);
  }
  return { dateKinds: kinds };
}

// ---- the XML scanner --------------------------------------------------------

/** `name="value"` pairs of a start tag's attribute text. */
function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
    out[m[1] as string] = decodeEntities(m[2] as string);
  }
  return out;
}

/** The text of an <si> / <is> body: every <t> (rich runs concatenate),
 *  phonetic guides dropped. */
function richTextOf(inner: string): string {
  const withoutPh = inner.replace(
    /<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g,
    "",
  );
  let s = "";
  for (const m of withoutPh.matchAll(
    /<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g,
  )) {
    s += decodeEntities(m[1] ?? "");
  }
  return s;
}

function readSharedStrings(
  pkg: OoxmlPackage,
  path: string | null,
): readonly string[] {
  if (path === null) return [];
  const text = partText(pkg, path);
  if (text === null) return [];
  const out: string[] = [];
  for (const m of text.matchAll(
    /<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g,
  )) {
    out.push(richTextOf(m[1] ?? ""));
  }
  return out;
}

// ---- sheets -----------------------------------------------------------------

/** Excel column width (character units) → px, the common approximation. */
function widthToPx(chars: number): number {
  return Math.round(chars * 7 + 5);
}

const ROW_RE = /<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g;
const CELL_RE = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
const V_RE = /<(?:\w+:)?v\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?v>)/;
const IS_RE = /<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/;

function readSheet(
  pkg: OoxmlPackage,
  name: string,
  path: string,
  shared: readonly string[],
  styles: Styles,
  date1904: boolean,
): Sheet {
  const empty: Sheet = {
    name,
    rows: [],
    rowCount: 0,
    colCount: 0,
    colWidths: [],
    merges: [],
    rowsCapped: false,
    colsCapped: false,
    skipped: false,
  };
  const text = partText(pkg, path);
  if (text === null) return empty;
  if (text.length > MAX_SHEET_XML_CHARS) return { ...empty, skipped: true };

  const colWidths: (number | undefined)[] = [];
  const colsSection = /<(?:\w+:)?cols\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cols>/.exec(
    text,
  )?.[1];
  if (colsSection !== undefined) {
    for (const m of colsSection.matchAll(/<(?:\w+:)?col\b([^>]*?)\/?>/g)) {
      const a = attrsOf(m[1] as string);
      const min = Number(a.min);
      const max = Number(a.max);
      const width = Number(a.width);
      if (![min, max, width].every(Number.isFinite)) continue;
      for (let c = min - 1; c < Math.min(max, MAX_SHEET_COLS); c++)
        colWidths[c] = widthToPx(width);
    }
  }

  const merges: Merge[] = [];
  for (const m of text.matchAll(
    /<(?:\w+:)?mergeCell\b[^>]*?\bref="([^"]+)"/g,
  )) {
    const parts = (m[1] as string).split(":");
    const a = parts[0] === undefined ? null : parseRef(parts[0]);
    const b = parts[1] === undefined ? null : parseRef(parts[1]);
    if (a === null || b === null) continue;
    merges.push({
      r1: Math.min(a.r, b.r),
      c1: Math.min(a.c, b.c),
      r2: Math.max(a.r, b.r),
      c2: Math.max(a.c, b.c),
    });
  }

  const rows: (Cell | undefined)[][] = [];
  let rowCount = 0;
  let colCount = 0;
  let rowsCapped = false;
  let colsCapped = false;
  const sheetData =
    /<(?:\w+:)?sheetData\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sheetData>/.exec(
      text,
    )?.[1] ?? "";
  let nextRow = 0;
  for (const rm of sheetData.matchAll(ROW_RE)) {
    const ra = attrsOf(rm[1] ?? "");
    const rAttr = Number(ra.r);
    const r =
      (Number.isFinite(rAttr) && ra.r !== undefined ? rAttr : nextRow + 1) - 1;
    nextRow = r + 1;
    if (r >= MAX_SHEET_ROWS) {
      rowsCapped = true;
      break;
    }
    const body = rm[2];
    if (body === undefined) continue;
    let nextCol = 0;
    const cells: (Cell | undefined)[] = [];
    for (const cm of body.matchAll(CELL_RE)) {
      const ca = attrsOf(cm[1] ?? "");
      const parsed = ca.r === undefined ? null : parseRef(ca.r);
      const col = parsed === null ? nextCol : parsed.c;
      nextCol = col + 1;
      if (col >= MAX_SHEET_COLS) {
        colsCapped = true;
        continue;
      }
      const cell = readCell(ca, cm[2] ?? "", shared, styles, date1904);
      if (cell === undefined) continue;
      cells[col] = cell;
      if (col + 1 > colCount) colCount = col + 1;
    }
    if (cells.length > 0) {
      rows[r] = cells;
      if (r + 1 > rowCount) rowCount = r + 1;
    }
  }

  // Fill the sparse holes so consumers index safely.
  for (let r = 0; r < rowCount; r++) rows[r] ??= [];

  return {
    name,
    rows,
    rowCount,
    colCount,
    colWidths,
    merges,
    rowsCapped,
    colsCapped,
    skipped: false,
  };
}

function readCell(
  ca: Record<string, string>,
  inner: string,
  shared: readonly string[],
  styles: Styles,
  date1904: boolean,
): Cell | undefined {
  const type = ca.t ?? "n";
  const s = ca.s === undefined ? null : Number(ca.s);
  if (type === "inlineStr") {
    const is = IS_RE.exec(inner)?.[1];
    return is === undefined ? undefined : { text: richTextOf(is), type: "s" };
  }
  const v = V_RE.exec(inner);
  if (v === null) return undefined;
  const raw = decodeEntities(v[1] ?? "");
  // A formula the writer never evaluated (`<f>…</f><v/>`, openpyxl's shape)
  // has nothing to show — not "0".
  if (raw.length === 0) return undefined;
  switch (type) {
    case "s": {
      const i = Number.parseInt(raw, 10);
      return { text: shared[i] ?? "", type: "s" };
    }
    case "str":
      return { text: raw, type: "s" };
    case "b":
      return { text: raw === "1" ? "TRUE" : "FALSE", type: "b" };
    case "e":
      return { text: raw, type: "e" };
    case "d":
      return { text: raw, type: "d" };
    default: {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { text: raw, type: "t" };
      const kind =
        s === null || !Number.isFinite(s)
          ? null
          : (styles.dateKinds[s] ?? null);
      if (kind !== null)
        return { text: formatSerial(n, kind, date1904), type: "d" };
      return { text: formatNumber(n), type: "n" };
    }
  }
}

/** Parse a .xlsx / .xlsm. Throws on a package that is not a workbook. */
export function parseWorkbook(bytes: Uint8Array): Workbook {
  const pkg = openPackage(bytes);
  const wbPath = "xl/workbook.xml";
  const wb = partXml(pkg, wbPath);
  if (wb === null) throw new Error("not a workbook");
  const rels = relsFor(pkg, wbPath);
  let sharedPath: string | null = null;
  let stylesPath: string | null = null;
  for (const rel of rels.values()) {
    if (rel.type === "sharedStrings") sharedPath = rel.target;
    else if (rel.type === "styles") stylesPath = rel.target;
  }
  const date1904 = descendants(wb, "workbookPr").some((p) => {
    const v = attr(p, "date1904");
    return v === "1" || v === "true";
  });
  const shared = readSharedStrings(pkg, sharedPath);
  const styles = readStyles(pkg, stylesPath);

  const sheets: Sheet[] = [];
  for (const sheetEl of descendants(wb, "sheet")) {
    const name = attr(sheetEl, "name") ?? `Sheet${sheets.length + 1}`;
    const rid = relId(sheetEl);
    const rel = rid === null ? undefined : rels.get(rid);
    if (rel === undefined || rel.type !== WORKSHEET_REL) continue;
    // Hidden sheets still list — they are the workbook's content.
    sheets.push(readSheet(pkg, name, rel.target, shared, styles, date1904));
  }
  return { sheets };
}
