// Shared text helpers for the knowledge package. Each of these used to be
// copy-pasted into 2–3 pipeline files (ingest chunker / corpus / claims pass;
// the two LLM prompt builders; the three self-model output validators) —
// one definition each now.
import { createHash } from "node:crypto";

/** Hex SHA-1 of a UTF-8 string — the content-hash the ingest pipeline keys
 *  chunks, documents and LLM annotations by. */
export function sha1(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex");
}

/** `JSON.stringify` with object keys sorted at every level, so two
 *  structurally equal payloads hash identically (prompt-cache keys). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, sortedReplacer);
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = obj[k];
  }
  return sorted;
}

/** Strip a leading ```json / ``` fence and a trailing ``` from an LLM reply
 *  that was asked for bare JSON but fenced it anyway. Non-fenced text is
 *  returned trimmed. */
export function stripMarkdownFence(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = /^```(?:json)?\s*\n?/i.exec(trimmed);
  if (fenceMatch === null) return trimmed;
  let body = trimmed.slice(fenceMatch[0].length);
  const endIdx = body.lastIndexOf("```");
  if (endIdx !== -1) body = body.slice(0, endIdx);
  return body.trim();
}
