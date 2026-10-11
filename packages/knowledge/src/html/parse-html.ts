import { parseHTML } from "linkedom";
import { cleanText, isBoilerplate } from "./clean-text.js";
import { computeSectionPath } from "./sectionizer.js";
import { parseSpeakerLine } from "./speaker-parser.js";

export type ParsedBlockKind =
  | "paragraph"
  | "dialogue"
  | "list_item"
  | "blockquote";

export interface ParsedBlock {
  kind: ParsedBlockKind;
  sectionPath: string[];
  speaker?: string;
  text: string;
}

export interface ParsedDocument {
  title: string;
  url?: string;
  blocks: ParsedBlock[];
}

export function parseHtmlDocument(html: string): ParsedDocument {
  const { document } = parseHTML(html);
  const titleEl =
    document.querySelector("h1") ?? document.querySelector("title");
  const title = cleanText(titleEl?.textContent ?? "");
  const urlEl = document.querySelector(".meta a, .meta-source a");
  const url = urlEl?.getAttribute("href") ?? undefined;

  const candidates = document.querySelectorAll(
    "p, li, blockquote, td",
  ) as unknown as ArrayLike<Element>;
  const blocks: ParsedBlock[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    if (el === undefined) continue;
    const raw = cleanText(el.textContent ?? "");
    if (raw.length === 0 || isBoilerplate(raw)) continue;
    const tag = el.tagName.toLowerCase();
    const rawPath = computeSectionPath(el);
    // Drop the document-title h1 from sectionPath. Brittle: if a page reuses
    // the title text as a sub-heading (e.g. <h1>X</h1>...<h2>X</h2>), this
    // strips it from blocks under that h2 too. No corpus pages do that today.
    const sectionPath = rawPath[0] === title ? rawPath.slice(1) : rawPath;

    if (tag === "li") {
      const sp = parseSpeakerLine(raw);
      if (sp !== null) {
        blocks.push({
          kind: "dialogue",
          sectionPath,
          speaker: sp.speaker,
          text: sp.text,
        });
      } else {
        blocks.push({ kind: "list_item", sectionPath, text: raw });
      }
      continue;
    }
    if (tag === "p") {
      const sp = parseSpeakerLine(raw);
      if (sp !== null) {
        blocks.push({
          kind: "dialogue",
          sectionPath,
          speaker: sp.speaker,
          text: sp.text,
        });
      } else {
        blocks.push({ kind: "paragraph", sectionPath, text: raw });
      }
      continue;
    }
    if (tag === "blockquote") {
      blocks.push({ kind: "blockquote", sectionPath, text: raw });
      continue;
    }
    blocks.push({ kind: "paragraph", sectionPath, text: raw });
  }
  return { title, url, blocks };
}
