/** Paths only; restoring a card never reads or submits the file. */
export interface PendingDoc {
  readonly id: string;
  readonly path: string;
  readonly name: string;
}

const key = (sessionId: string): string =>
  `the-herta.pending-documents.v1.${encodeURIComponent(sessionId)}`;
const valid = (value: unknown): value is PendingDoc[] =>
  Array.isArray(value) && value.length <= 100 &&
  value.every((item) => item !== null && typeof item === "object" &&
    typeof item.id === "string" && item.id.length > 0 && item.id.length <= 128 &&
    typeof item.path === "string" && item.path.length > 0 && item.path.length <= 32768 &&
    typeof item.name === "string" && item.name.length > 0 && item.name.length <= 32768) &&
  new Set(value.map((item) => item.id)).size === value.length;

/** Why the queue could not be kept. The surface that shows it owns the words
 *  (renderer libraries carry no Chinese text, no-hardcoded-cjk; R98). */
export type PendingDocsIssue = "unreadable" | "not_overwritten" | "not_saved";

export function readPendingDocs(sessionId: string): { docs: PendingDoc[]; error?: PendingDocsIssue } {
  try {
    const raw = localStorage.getItem(key(sessionId));
    if (raw === null) return { docs: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!valid(parsed)) throw new Error("invalid queue");
    return { docs: parsed };
  } catch {
    return { docs: [], error: "unreadable" };
  }
}

/** A single setItem is atomic. Never overwrite an unreadable existing record. */
export function writePendingDocs(sessionId: string, docs: PendingDoc[]): PendingDocsIssue | undefined {
  if (readPendingDocs(sessionId).error) return "not_overwritten";
  try {
    if (!valid(docs)) throw new Error("invalid queue");
    if (docs.length) localStorage.setItem(key(sessionId), JSON.stringify(docs));
    else localStorage.removeItem(key(sessionId));
    return undefined;
  } catch {
    return "not_saved";
  }
}
