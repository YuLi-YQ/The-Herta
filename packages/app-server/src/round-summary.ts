/** Persisted, evidence-backed workbench view. Missing facts stay null/unknown. */
export type RoundStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface RoundFile {
  id: string;
  path: string;
  previousPath?: string;
  kind: "added" | "modified" | "deleted" | "renamed";
  added: number | null;
  removed: number | null;
  confidence: "tool" | "observed";
  unavailable?: string;
}
export interface RoundActivity {
  id: string;
  attemptId: string;
  kind: string;
  title: string;
  status:
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "denied"
    | "unknown";
  startedAt?: string;
  durationMs: number | null;
  summary: string;
  command?: string;
  cwd?: string;
  exitCode?: number;
  detail?: string;
  truncated?: boolean;
  files: { fileId: string; path: string; line?: number }[];
}
/** F04 (R115): what one request did with a picture the record cites: sent, or why not
 *  (neutral-images.ts `ImageMiss`). Index and stored path both, since a rewind reuses indices:
 *  a reader matches a row only when both agree. */
export interface RoundPicture {
  index: number;
  path: string;
  outcome: "sent" | "unsupported" | "unreadable" | "over_limit" | "stopped";
}
export interface RoundMetrics {
  totalTokens: number | null;
  cacheHitRate: number | null;
  outputTokensPerSecond: number | null;
  contextUsed: number | null;
  contextWindow: number | null;
  partial: boolean;
}
export interface RoundSummary {
  searches?: import("@herta/providers").WebSearchEvent[];
  schemaVersion: 1;
  id: string;
  sessionId: string;
  attemptIds: string[];
  recordStart: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: RoundStatus;
  files: RoundFile[];
  activities: RoundActivity[];
  publicReasoning?: {
    id: string;
    role: "persona" | "executor";
    format: "text" | "summary";
    text: string;
    truncated: boolean;
  }[];
  metrics: RoundMetrics;
  limitations: string[];
  /** F04 (R115): the pictures of the round's persona request and of its latest delegation, row
   *  by row (the newest 64 rows each). Absent before R115 and when the record cites no picture. */
  pictures?: { persona?: RoundPicture[]; executor?: RoundPicture[] };
}
export interface RoundFileContent {
  /** Renderer navigation hint; never used to select a disk path. */
  targetLine?: number;
  diff?: string;
  sourceLabel?: string;
  roundId: string;
  fileId: string;
  path: string;
  before: string | null;
  after: string | null;
  language?: string;
  unavailable?: string;
}
