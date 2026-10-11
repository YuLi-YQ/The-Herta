import { useMemo, useState } from "react";
import { useT } from "../../../i18n/LocaleProvider.js";
import { GridView } from "./GridView.js";
import { parseWorkbook } from "./xlsx.js";

/**
 * A workbook in the panel (ADR 0054 §4): the grid, and the sheet tabs
 * along the bottom the way the spreadsheet itself shows them. Parsing
 * throws for a package that is not a workbook — the error boundary above
 * turns that into the honest notice.
 */
export function SheetView({
  bytes,
}: {
  readonly bytes: Uint8Array;
}): JSX.Element {
  const t = useT();
  const workbook = useMemo(() => parseWorkbook(bytes), [bytes]);
  const [active, setActive] = useState(0);
  const sheet = workbook.sheets[active] ?? workbook.sheets[0];
  if (sheet === undefined) {
    return (
      <div className="file-viewer__body">
        <p className="file-viewer__notice">{t("viewer.emptySheet")}</p>
      </div>
    );
  }
  const tabs =
    workbook.sheets.length > 1 ? (
      <div className="file-viewer__sheet-tabs" role="tablist">
        {workbook.sheets.map((s, i) => (
          // Sheet names are unique within a workbook (the format forbids
          // duplicates), so the name is the identity.
          <button
            key={s.name}
            type="button"
            role="tab"
            aria-selected={i === active}
            className={`file-viewer__sheet-tab${i === active ? " is-active" : ""}`}
            onClick={() => setActive(i)}
          >
            {s.name}
          </button>
        ))}
      </div>
    ) : undefined;
  if (sheet.skipped || sheet.rowCount === 0) {
    return (
      <div className="file-viewer__body">
        <div className="file-viewer__scroll">
          <p className="file-viewer__notice">
            {sheet.skipped ? t("viewer.tooLarge") : t("viewer.emptySheet")}
          </p>
        </div>
        {tabs}
      </div>
    );
  }
  return <GridView data={sheet} footer={tabs} />;
}
