import { parseHTML } from "linkedom";
import type { ParsedDocument } from "../html/parse-html.js";

const BR_MARKER = "";

/**
 * Fallback extractor for HTML files that store content inside nested
 * `<div>` elements with `<br/>` separators rather than the canonical
 * `<p>` / `<li>` / `<blockquote>` / `<td>` structure that
 * `parseHtmlDocument` matches.
 *
 * Observed in HSR wiki sim_universe pages (~5% of the corpus). Since
 * `parseHtmlDocument` returns zero blocks for these files, we run this
 * fallback when its output is empty. It strips script/style, replaces
 * `<br>` with a sentinel, takes the body's plain-text content, and
 * splits on the sentinel — yielding one paragraph per `<br>`-bounded
 * segment.
 *
 * Loses speaker structure (the canonical pipeline's `parseSpeakerLine`
 * is not applied) — but the speaker pattern `角色<级别> 「dialogue」` is
 * still detectable as plain text by the LLM downstream.
 */
export function extractFromBrStructure(html: string): ParsedDocument {
  const { document } = parseHTML(html);

  // Title: prefer <h1>, fall back to <title>.
  const titleEl =
    document.querySelector("h1") ?? document.querySelector("title");
  const title = (titleEl?.textContent ?? "").trim();

  // Strip script/style nodes — their textContent would otherwise leak
  // through the body extraction below.
  for (const tag of ["script", "style"] as const) {
    const nodes = document.querySelectorAll(tag);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      n?.parentNode?.removeChild(n);
    }
  }

  // Replace every <br> / <br/> with a sentinel so we can split after
  // textContent extraction. linkedom doesn't render <br> as a newline
  // in textContent — it emits nothing for void elements — so we have
  // to inject the marker before reading.
  const brs = document.querySelectorAll("br");
  for (let i = 0; i < brs.length; i++) {
    const br = brs[i];
    if (br === undefined) continue;
    const marker = document.createTextNode(BR_MARKER);
    br.parentNode?.replaceChild(marker, br);
  }

  const body = document.body ?? document.documentElement;
  const raw = body?.textContent ?? "";

  const segments = raw
    .split(BR_MARKER)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);

  return {
    title,
    blocks: segments.map((text) => ({
      kind: "paragraph",
      sectionPath: [],
      text,
    })),
  };
}
