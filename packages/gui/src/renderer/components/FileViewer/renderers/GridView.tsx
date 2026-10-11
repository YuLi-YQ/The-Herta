import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../../i18n/LocaleProvider.js";
import { type Cell, columnLetters, MAX_SHEET_COLS } from "./xlsx.js";

/**
 * The grid the spreadsheet kinds share (ADR 0054 §4): column letters
 * across, row numbers down, both sticky; rows virtualized on a fixed
 * height so a 10k-row sheet costs a viewport of DOM. Merged ranges show
 * their anchor cell's value and leave the rest blank — no spanning under
 * virtualization; the number is what matters in a quick look.
 */
export const ROW_H = 24;
const HEADER_H = 24;
const GUTTER_W = 46;
const DEFAULT_COL_W = 92;
const OVERSCAN = 12;

export interface GridData {
  readonly rows: readonly (readonly (Cell | string | undefined)[])[];
  readonly rowCount: number;
  readonly colCount: number;
  readonly colWidths?: readonly (number | undefined)[];
  readonly rowsCapped?: boolean;
  readonly colsCapped?: boolean;
}

function cellOf(v: Cell | string | undefined): Cell | undefined {
  if (v === undefined) return undefined;
  return typeof v === "string" ? { text: v, type: "t" } : v;
}

export function GridView({
  data,
  footer,
}: {
  readonly data: GridData;
  /** Rendered under the grid — the sheet tabs. */
  readonly footer?: React.ReactNode;
}): JSX.Element {
  const t = useT();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState({ from: 0, to: 0 });
  const colCount = Math.min(data.colCount, MAX_SHEET_COLS);
  const widths: number[] = [];
  for (let c = 0; c < colCount; c++)
    widths.push(data.colWidths?.[c] ?? DEFAULT_COL_W);
  const totalW = GUTTER_W + widths.reduce((a, b) => a + b, 0);
  const totalH = HEADER_H + data.rowCount * ROW_H;

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    const first = Math.max(0, Math.floor(el.scrollTop / ROW_H) - OVERSCAN);
    const visible = Math.ceil((el.clientHeight || 600) / ROW_H) + OVERSCAN * 2;
    const last = Math.min(data.rowCount, first + visible);
    setRange((r) =>
      r.from === first && r.to === last ? r : { from: first, to: last },
    );
  }, [data.rowCount]);

  useEffect(() => {
    measure();
    const el = scrollerRef.current;
    if (el === null) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const rowsToDraw: JSX.Element[] = [];
  for (let r = range.from; r < range.to; r++) {
    const row = data.rows[r] ?? [];
    const cells: JSX.Element[] = [];
    let x = GUTTER_W;
    for (let c = 0; c < colCount; c++) {
      const cell = cellOf(row[c]);
      const w = widths[c] as number;
      if (cell !== undefined) {
        cells.push(
          <div
            key={c}
            className={`file-viewer__cell is-${cell.type}`}
            style={{ left: x, width: w }}
          >
            {cell.text}
          </div>,
        );
      }
      x += w;
    }
    rowsToDraw.push(
      <div
        key={r}
        className="file-viewer__row"
        style={{ top: HEADER_H + r * ROW_H, width: totalW }}
      >
        <div className="file-viewer__rowhead" style={{ width: GUTTER_W }}>
          {r + 1}
        </div>
        {cells}
      </div>,
    );
  }

  const heads: JSX.Element[] = [];
  {
    let x = GUTTER_W;
    for (let c = 0; c < colCount; c++) {
      const w = widths[c] as number;
      heads.push(
        <div
          key={c}
          className="file-viewer__colhead"
          style={{ left: x, width: w }}
        >
          {columnLetters(c)}
        </div>,
      );
      x += w;
    }
  }

  return (
    <div className="file-viewer__body">
      <div
        ref={scrollerRef}
        className="file-viewer__scroll file-viewer__grid"
        onScroll={measure}
      >
        <div
          className="file-viewer__grid-canvas"
          style={{ width: totalW, height: totalH }}
        >
          <div className="file-viewer__gridhead" style={{ width: totalW }}>
            <div className="file-viewer__corner" style={{ width: GUTTER_W }} />
            {heads}
          </div>
          {rowsToDraw}
        </div>
      </div>
      {(data.rowsCapped === true || data.colsCapped === true) && (
        <p className="file-viewer__notice">
          {data.rowsCapped === true
            ? t("viewer.rowsCapped", { n: data.rowCount })
            : t("viewer.colsCapped", { n: colCount })}
        </p>
      )}
      {footer}
    </div>
  );
}
