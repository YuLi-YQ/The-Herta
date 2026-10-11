import type { ParsedDocument } from "../html/parse-html.js";

/**
 * Format a `ParsedDocument` (output of the existing `parseHtmlDocument`)
 * as plain text suitable for an LLM prompt. Output structure:
 *
 *   == <title> ==
 *
 *   -- <section path with > separator> --
 *   <paragraph text>
 *   [<speaker>] <dialogue text>
 *   - <list item>
 *   > <blockquote>
 *
 * Section headers only emit when the path changes between consecutive
 * blocks. The title is omitted when empty (avoids a stray `==  ==`).
 */
export function formatCleanedText(doc: ParsedDocument): string {
  if (doc.title.length === 0 && doc.blocks.length === 0) return "";

  const lines: string[] = [];
  if (doc.title.length > 0) {
    lines.push(`== ${doc.title} ==`);
    lines.push("");
  }

  let prevSectionKey: string | null = null;

  for (const block of doc.blocks) {
    const sectionKey = block.sectionPath.join(" > ");
    if (sectionKey !== prevSectionKey && sectionKey.length > 0) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      lines.push(`-- ${sectionKey} --`);
      prevSectionKey = sectionKey;
    } else if (sectionKey === "" && prevSectionKey !== null) {
      prevSectionKey = null;
    }

    let formatted: string;
    switch (block.kind) {
      case "paragraph":
        formatted = block.text;
        break;
      case "dialogue":
        formatted = `[${block.speaker ?? "?"}] ${block.text}`;
        break;
      case "list_item":
        formatted = `- ${block.text}`;
        break;
      case "blockquote":
        formatted = `> ${block.text}`;
        break;
    }
    lines.push(formatted.trimEnd());
  }

  return lines.join("\n");
}
