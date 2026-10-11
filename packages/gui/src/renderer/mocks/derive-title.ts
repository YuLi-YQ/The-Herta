import type { TerminalRecord } from "@herta/app-server";

const MAX_LEN = 28;

/**
 * Derive a sidebar-display title from a record by taking the first
 * user block's text, truncated to ~28 chars with an ellipsis. Used
 * in Slice 3 because the session_meta header has no title field
 * yet. When a real title surface lands (future slice) this helper
 * can be dropped.
 */
export function deriveTitle(record: TerminalRecord): string {
  for (const block of record) {
    if (block.kind === "user") {
      if (block.text.length <= MAX_LEN) return block.text;
      return `${block.text.slice(0, MAX_LEN).trimEnd()}…`;
    }
  }
  return "Untitled";
}
