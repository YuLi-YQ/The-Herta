/** Workbench compaction only changes future model context; the transcript stays intact. */
export type CompactStatus =
  | "idle"
  | "scheduled"
  | "running"
  | "completed"
  | "skipped"
  | "failed";
export type CompactReason =
  | "nothing_to_compact"
  | "provider"
  | "invalid_summary"
  | "storage"
  | "circuit_open"
  | "cancelled"
  | "input_limit";
export interface CompactRecap {
  readonly text: string;
  /** Record blocks in [0, boundaryIndex) are covered by the saved recap. */
  readonly boundaryIndex: number;
  /** Older caches have no trustworthy generation timestamp. */
  readonly generatedAt: string | null;
}
export interface CompactView {
  readonly revision: number;
  readonly status: CompactStatus;
  readonly reason?: CompactReason;
  readonly scheduledPersistent: false;
  readonly recap: CompactRecap | null;
  readonly recordLength: number;
}
export type CompactAction =
  | { readonly type: "schedule" }
  | { readonly type: "cancel" };
export type CompactReply =
  | { readonly ok: true; readonly view: CompactView }
  | {
      readonly ok: false;
      readonly reason:
        | "no_target"
        | "busy"
        | "conflict"
        | "invalid"
        | "unavailable";
      readonly view?: CompactView;
    };
export function parseCompactAction(value: unknown): CompactAction | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    Object.keys(value)[0] !== "type"
  )
    return null;
  const type = (value as { type?: unknown }).type;
  return type === "schedule" || type === "cancel" ? { type } : null;
}
