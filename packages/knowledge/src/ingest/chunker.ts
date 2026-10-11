import type { ParsedDocument } from "../html/parse-html.js";
import type { CanonChunk, CanonDocumentKind } from "../schema.js";
import { sha1 } from "../text-utils.js";

export function classifyDocumentKind(path: string): CanonDocumentKind {
  const norm = path.replace(/\\/g, "/");
  if (norm.includes("/角色图鉴/")) return "character_profile";
  if (norm.includes("/plot_html/模拟宇宙/")) return "simulated_universe";
  if (norm.includes("/plot_html/")) return "mission_dialogue";
  if (norm.includes("/book_html/")) return "book_readable";
  if (norm.includes("/星海纪闻/")) return "world_lore";
  if (norm.includes("/编年史/")) return "chronology";
  return "unknown";
}

export interface ChunkOpts {
  documentId: string;
}

export function chunkParsedDocument(
  doc: ParsedDocument,
  opts: ChunkOpts,
): CanonChunk[] {
  const chunks: CanonChunk[] = [];
  let ordinal = 0;
  for (const b of doc.blocks) {
    if (b.text.length === 0) continue;
    const id = `${opts.documentId}#${ordinal}`;
    chunks.push({
      id,
      documentId: opts.documentId,
      ordinal,
      sectionPath: b.sectionPath,
      speaker: b.speaker,
      text: b.text,
      textHash: sha1(b.text),
      tokenEstimate: estimateTokens(b.text),
      isDialogue: b.kind === "dialogue",
      isHertaVoiceEvidence: false,
      isCanonFactCandidate: false,
      qualityScore: scoreQuality(b.text, b.kind),
    });
    ordinal += 1;
  }
  return chunks;
}

function estimateTokens(s: string): number {
  // Rough: 1 CJK char ≈ 1 token, 4 ascii chars ≈ 1 token.
  let cjk = 0;
  let ascii = 0;
  for (const ch of s) {
    if (/[一-鿿]/.test(ch)) cjk += 1;
    else ascii += 1;
  }
  return cjk + Math.ceil(ascii / 4);
}

function scoreQuality(text: string, kind: string): number {
  let score = 0;
  if (text.length >= 12) score += 0.3;
  if (text.length >= 40) score += 0.2;
  if (kind === "dialogue") score += 0.2;
  if (text.includes("黑塔")) score += 0.1;
  return Math.min(1, score);
}
