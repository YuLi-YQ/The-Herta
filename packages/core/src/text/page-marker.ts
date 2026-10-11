/**
 * The line that opens each page of a PDF's extracted text (large-document
 * lab, 2026-08-23; owner decision the same day).
 *
 * pdfjs hands back one text block per page and the ingest used to join them
 * with a blank line, so page boundaries were invisible in the stored text:
 * 板砖 could not jump to a page, could not cite one, and in the lab it
 * ESTIMATED page numbers for the user ("按 28.3 行/页折算"). The marker makes
 * a page a greppable, citable line — `grep -n '^── 第'` is a page→line map,
 * and a `report_finding` cite of the marker's line IS a page cite.
 *
 * ONE definition, in core, because three things must agree on the shape:
 * the ingest that writes it (app-server), the record digest that records
 * which shape a stored file carries (`pageMarker`), and the backend task
 * line that tells 板砖 how to find pages (herta). The shape is localized
 * like every other piece of harness-authored prose the user may read
 * (ADR 0016) — the head excerpt shows it — and the digest stores the exact
 * string, so a record is self-describing even if a session's language and
 * the file's ever disagree.
 *
 * `──` (U+2500 ×2) is a character no document text of either language
 * begins a line with in practice, so a `^──` anchor finds markers and
 * nothing else; the spaced digits keep it readable to a person.
 */
export type PageMarkerLang = "zh" | "en";

export function pageMarkerLine(page: number, lang: PageMarkerLang): string {
  return lang === "en" ? `── page ${page} ──` : `── 第 ${page} 页 ──`;
}

/** The shape with `N` in place of the number — what prose quotes when it
 *  tells a reader how pages are marked. */
export function pageMarkerShape(lang: PageMarkerLang): string {
  return lang === "en" ? "── page N ──" : "── 第 N 页 ──";
}
