/**
 * Composer cards that never became attachments (R99): a file that was refused, or one
 * still being read when the window closed or the task changed. Kept per task beside the
 * pending-document queue so the card survives a restart instead of vanishing — a user who
 * no longer sees it would reasonably believe every file went with the message.
 *
 * Paths and names only. A pasted picture's bytes are never stored, so it comes back as a
 * card that asks for a fresh paste. Restoring never reads, stages or sends anything.
 *
 * The independent chat keeps its own cards the same way since R102, under its own key. A chat
 * file is only ever bytes, so its records carry no path and come back without a retry.
 */
export interface AttachIssue {
  readonly id: string;
  readonly name: string;
  /** The file on disk; absent for a pasted picture. */
  readonly path?: string;
  /** Why it was refused, as the card showed it; absent while it was still being read. */
  readonly error?: string;
}

/** Why the record could not be kept. The surface owns the words (no-hardcoded-cjk). */
export type AttachIssuesProblem = "unreadable" | "not_overwritten" | "not_saved";
/** Whose cards: a workbench task's (R99) or an independent chat's (R102). The keys differ,
 *  so neither surface ever reads the other's cards, whatever their ids. */
export type AttachIssuesScope = "task" | "chat";

const key = (sessionId: string, scope: AttachIssuesScope): string =>
  scope === "chat"
    ? `the-herta.chat-attach-issues.v1.${encodeURIComponent(sessionId)}`
    : `the-herta.pending-attach-issues.v1.${encodeURIComponent(sessionId)}`;
const text = (value: unknown, max: number): boolean =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const valid = (value: unknown): value is AttachIssue[] =>
  Array.isArray(value) && value.length <= 100 &&
  value.every((item) => item !== null && typeof item === "object" &&
    text(item.id, 128) && text(item.name, 32768) &&
    (item.path === undefined || text(item.path, 32768)) &&
    (item.error === undefined || text(item.error, 2000))) &&
  new Set(value.map((item) => item.id)).size === value.length;

export function readAttachIssues(
  sessionId: string,
  scope: AttachIssuesScope = "task",
): { issues: AttachIssue[]; error?: AttachIssuesProblem } {
  try {
    const raw = localStorage.getItem(key(sessionId, scope));
    if (raw === null) return { issues: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!valid(parsed)) throw new Error("invalid issues");
    return { issues: parsed };
  } catch {
    return { issues: [], error: "unreadable" };
  }
}

/** A single setItem is atomic. Never overwrite an unreadable existing record. */
export function writeAttachIssues(
  sessionId: string,
  issues: AttachIssue[],
  scope: AttachIssuesScope = "task",
): AttachIssuesProblem | undefined {
  if (readAttachIssues(sessionId, scope).error) return "not_overwritten";
  try {
    if (!valid(issues)) throw new Error("invalid issues");
    // Only the known fields: whatever else a caller's object carries (a pasted
    // picture's bytes, say) never reaches storage.
    const kept = issues.map(({ id, name, path, error }) => ({
      id, name, ...(path === undefined ? {} : { path }), ...(error === undefined ? {} : { error }),
    }));
    if (kept.length) localStorage.setItem(key(sessionId, scope), JSON.stringify(kept));
    else localStorage.removeItem(key(sessionId, scope));
    return undefined;
  } catch {
    return "not_saved";
  }
}
