import { useMemo } from "react";
import { useT } from "../../../i18n/LocaleProvider.js";
import { parseCsv } from "./csv.js";
import { GridView } from "./GridView.js";

/** CSV / TSV as the grid (ADR 0054 §4). */
export function CsvView({
  content,
  truncated,
}: {
  readonly content: string;
  readonly truncated: boolean;
}): JSX.Element {
  const t = useT();
  const table = useMemo(() => parseCsv(content), [content]);
  return (
    <GridView
      data={{
        rows: table.rows,
        rowCount: table.rows.length,
        colCount: table.cols,
        rowsCapped: table.capped,
      }}
      footer={
        truncated ? (
          <p className="file-viewer__notice">{t("viewer.truncatedNote")}</p>
        ) : undefined
      }
    />
  );
}
