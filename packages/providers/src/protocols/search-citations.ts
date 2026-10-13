import { webSource, type WebSearchEvent } from "../web-search.js";
/** Render only service annotations; arbitrary titles cannot introduce Markdown. */
export function citedOutput(items: unknown[]): {
  text: string;
  citations: WebSearchEvent[];
} {
  const citations: WebSearchEvent[] = [];
  const texts: string[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type !== "output_text" || typeof part.text !== "string")
        continue;
      let text = part.text;
      const edits: { start: number; end: number; link: string }[] = [];
      const fallback: string[] = [];
      for (const annotation of (Array.isArray(part.annotations)
        ? part.annotations
        : []
      ).slice(0, 100)) {
        if (annotation?.type !== "url_citation") continue;
        const source = webSource(annotation);
        if (!source) continue;
        const url = source.url.replace(/[<>\\()\s]/g, (c) =>
          encodeURIComponent(c),
        );
        const link = `[来源${citations.length + 1}](<${url}>)`;
        citations.push({
          type: "web-search",
          id: `citation-${citations.length}`,
          status: "citation",
          sources: [source],
        });
        const start = annotation.start_index,
          end = annotation.end_index;
        if (
          Number.isInteger(start) &&
          Number.isInteger(end) &&
          start >= 0 &&
          end >= start &&
          end <= text.length &&
          !edits.some((e) => start < e.end && end > e.start)
        )
          edits.push({ start, end, link });
        else fallback.push(link);
      }
      for (const edit of edits.sort((a, b) => b.start - a.start))
        text = text.slice(0, edit.start) + edit.link + text.slice(edit.end);
      texts.push(text + (fallback.length ? "\n\n" + fallback.join(" ") : ""));
    }
  }
  return { text: texts.join("\n\n"), citations };
}
