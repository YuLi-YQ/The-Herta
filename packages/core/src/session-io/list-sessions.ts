import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSessionTitle } from "./session-title-sidecar.js";

export interface SessionListEntry {
  sessionId: string;
  sessionFile: string;
  startedAt: string;
  workspaceRoot: string;
  backendWorkspace?: string;
  preview: string;
  mtime: Date;
  /** Generated session title from the title sidecar, if one exists. */
  title?: string;
  /** The LAST user message in the transcript (where the user left off),
   *  truncated. Undefined when the session has no user message yet. */
  lastUserText?: string;
  /** The interaction language this session was created under (header `lang`).
   *  Undefined for legacy (pre-persistence) headers, which are all Chinese —
   *  the sidebar treats absent as "zh". Lets each card localize its own
   *  preview (e.g. the 板砖→Brick alias) independent of the active session. */
  lang?: "zh" | "en";
}

export interface ListSessionsOpts {
  /** Absolute path of the transcript dir (typically `<workspace>/.herta/transcript/v2`). */
  transcriptDir: string;
  /** Current workspace root for filtering. */
  currentWorkspaceRoot: string;
  /** Default 10. */
  limit?: number;
  /** When true, do not filter by workspaceRoot. Default false. */
  allWorkspaces?: boolean;
}

const PREVIEW_MAX = 60;
const PREVIEW_SCAN_LINES = 5;
const LAST_USER_MAX = 140;

/** Bounded read windows (2026-07-12): the list needs only the file's HEAD
 *  (header + first-user preview) and TAIL (last user message), so it reads
 *  64KB of each instead of the whole file — a multi-MB transcript no longer
 *  costs its full bytes per sidebar refresh. Known degradation, accepted:
 *  a session whose LAST user message sits more than 64KB before EOF (>64KB
 *  of backend/system blocks after it) shows no `lastUserText`. */
const HEAD_SCAN_BYTES = 64 * 1024;
const TAIL_SCAN_BYTES = 64 * 1024;

/** Header-only listing reads just enough to cover the first line (the
 *  `session_meta` header); a header carries only ids + two workspace paths,
 *  so 16KB is far more than any real header line. A pathologically long
 *  header that overruns this window fails its JSON.parse and the file is
 *  skipped — same tolerance as every other malformed-header case. */
const HEADER_SCAN_BYTES = 16 * 1024;

/** Read `length` bytes at `position` as UTF-8. A window edge can split a
 *  multi-byte char; both callers tolerate it (the garbled piece lands in a
 *  partial line that is dropped or fails its JSON.parse). */
function readWindow(fd: number, position: number, length: number): string {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, position);
  return buf.toString("utf8", 0, n);
}

interface ValidatedSessionHeader {
  sessionId: string;
  startedAt: string;
  workspaceRoot: string;
  backendWorkspace?: string;
  lang?: "zh" | "en";
}

/** Parse + validate a session file's first line as a v1 `session_meta`
 *  header. Returns null for a blank line, malformed JSON, or a header that
 *  fails the v1 shape check — every caller skips the file on null. Shared by
 *  the full listing and the header-only listing so the two can't drift on
 *  what counts as a valid header. */
function parseSessionHeader(firstLine: string): ValidatedSessionHeader | null {
  if (firstLine.length === 0) return null;
  let header: {
    _kind?: unknown;
    version?: unknown;
    sessionId?: unknown;
    startedAt?: unknown;
    workspaceRoot?: unknown;
    backendWorkspace?: unknown;
    lang?: unknown;
  };
  try {
    header = JSON.parse(firstLine);
  } catch {
    return null; // malformed header — skip
  }
  if (
    header._kind !== "session_meta" ||
    header.version !== 1 ||
    typeof header.sessionId !== "string" ||
    typeof header.startedAt !== "string" ||
    typeof header.workspaceRoot !== "string"
  ) {
    return null;
  }
  // Only "zh"/"en" are valid; a legacy/absent or stray value → undefined
  // (treated as zh downstream).
  const lang =
    header.lang === "zh" || header.lang === "en" ? header.lang : undefined;
  return {
    sessionId: header.sessionId,
    startedAt: header.startedAt,
    workspaceRoot: header.workspaceRoot,
    ...(typeof header.backendWorkspace === "string"
      ? { backendWorkspace: header.backendWorkspace }
      : {}),
    ...(lang !== undefined ? { lang } : {}),
  };
}

/**
 * Enumerate recent v0.2 session files.
 *
 * For each `*.jsonl` in `transcriptDir`, reads the first ~5 lines, parses
 * the header + first user block, builds a `SessionListEntry`. Skips
 * malformed files silently (they may be partial writes from older crashes).
 *
 * Filters by `currentWorkspaceRoot` unless `allWorkspaces: true`. Sorts by
 * mtime descending (newest first). Returns up to `limit` entries.
 *
 * **Performance (2026-07-12):** bounded reads — 64KB of the file's head
 * (header + preview) and, for larger files, 64KB of its tail (last user
 * message) — so a multi-MB transcript costs ~128KB per listing instead of
 * its full size. See HEAD_SCAN_BYTES for the accepted lastUserText
 * degradation. The spec §7 (R4) `.index.json` cache remains the next step
 * if 1000s of sessions ever make even this too hot.
 *
 * **Bounded to the limit (2026-09-03):** files are stat'd and sorted first,
 * and only as many are READ as the limit needs — the sidebar's refresh on
 * every session switch no longer opens every transcript on disk.
 *
 * **Unlimited results:** pass `limit: Number.POSITIVE_INFINITY` to return
 * every matching session. Used by Task 4's `/resume <prefix>` to collect all
 * candidates before client-side prefix-matching.
 *
 * SPEC v0.2 Slice 7b §5.
 */
export function listSessions(opts: ListSessionsOpts): SessionListEntry[] {
  const limit = opts.limit ?? 10;

  let files: string[];
  try {
    files = readdirSync(opts.transcriptDir).filter((f) => f.endsWith(".jsonl"));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return [];
    throw err;
  }

  // Stat every file (cheap), sort newest-first, then READ only until the
  // limit is met (2026-09-03). Before this the head/tail windows, the JSON
  // parses and the title-sidecar open ran for every transcript on disk and
  // the limit was applied to the finished array — 400 transcripts cost 400
  // × (open + two reads + sidecar) of blocked main thread on every session
  // switch, for a sidebar that shows the newest 200. A file from another
  // workspace still has to be read to be recognised (the root is in its
  // header), so it costs its head and does not count.
  const stats: { sessionFile: string; mtime: Date; size: number }[] = [];
  for (const filename of files) {
    const sessionFile = join(opts.transcriptDir, filename);
    try {
      const st = statSync(sessionFile);
      stats.push({ sessionFile, mtime: st.mtime, size: st.size });
    } catch {
      // unreadable; skip
    }
  }
  // Stable, so equal mtimes keep directory order — the same order the
  // post-read sort produced before.
  stats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  const entries: SessionListEntry[] = [];
  for (const { sessionFile, mtime, size } of stats) {
    if (entries.length >= limit) break;
    let head: string;
    // null when the head window covers the whole file (small transcript).
    let tailStr: string | null = null;
    try {
      const fd = openSync(sessionFile, "r");
      try {
        head = readWindow(fd, 0, Math.min(size, HEAD_SCAN_BYTES));
        if (size > HEAD_SCAN_BYTES) {
          tailStr = readWindow(fd, size - TAIL_SCAN_BYTES, TAIL_SCAN_BYTES);
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    const headLines = head.split("\n");
    const lines = headLines.slice(0, PREVIEW_SCAN_LINES + 1);
    const header = parseSessionHeader(lines[0] ?? "");
    if (header === null) continue;
    if (
      opts.allWorkspaces !== true &&
      header.workspaceRoot !== opts.currentWorkspaceRoot
    ) {
      continue;
    }

    // Find first user block in the scanned lines.
    let preview = "(no user message)";
    for (let i = 1; i < lines.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: i is bounded by lines.length
      const line = lines[i]!;
      if (line === "") continue;
      try {
        const block = JSON.parse(line) as { kind?: string; text?: string };
        if (block.kind === "user" && typeof block.text === "string") {
          preview =
            block.text.length > PREVIEW_MAX
              ? `${block.text.slice(0, PREVIEW_MAX)}...`
              : block.text;
          break;
        }
      } catch {
        // ignore individual line parse errors
      }
    }

    // Find the LAST user block — the message the user most recently sent
    // (where they left off). Scans backward over the TAIL window for large
    // files (its first element is a likely-partial line — and the landing
    // spot for any mid-char window split — so it is dropped), or over the
    // head lines (minus the header) when the head covered the whole file.
    let scanLines: string[];
    let scanFloor: number;
    if (tailStr === null) {
      scanLines = headLines;
      scanFloor = 1; // index 0 is the header
    } else {
      scanLines = tailStr.split("\n");
      scanLines.shift();
      scanFloor = 0;
    }
    let lastUserText: string | undefined;
    for (let i = scanLines.length - 1; i >= scanFloor; i--) {
      const line = scanLines[i];
      if (line === undefined || line === "") continue;
      try {
        const block = JSON.parse(line) as { kind?: string; text?: string };
        if (block.kind === "user" && typeof block.text === "string") {
          lastUserText =
            block.text.length > LAST_USER_MAX
              ? `${block.text.slice(0, LAST_USER_MAX)}…`
              : block.text;
          break;
        }
      } catch {
        // ignore individual line parse errors
      }
    }

    const title = readSessionTitle(opts.transcriptDir, header.sessionId);
    entries.push({
      sessionId: header.sessionId,
      sessionFile,
      startedAt: header.startedAt,
      workspaceRoot: header.workspaceRoot,
      ...(header.backendWorkspace !== undefined
        ? { backendWorkspace: header.backendWorkspace }
        : {}),
      preview,
      mtime,
      ...(title !== undefined ? { title } : {}),
      ...(lastUserText !== undefined ? { lastUserText } : {}),
      ...(header.lang !== undefined ? { lang: header.lang } : {}),
    });
  }

  // Already newest-first and bounded: the read loop walked the sorted stats
  // and stopped at the limit.
  return entries;
}

/** A session reduced to just its header fields + mtime — everything the
 *  content-search path needs (session id + newest-first order) and nothing it
 *  discards. */
export interface SessionHeaderEntry {
  sessionId: string;
  workspaceRoot: string;
  startedAt: string;
  mtime: Date;
  lang?: "zh" | "en";
}

/**
 * Header-only sibling of {@link listSessions}: reads only each file's first
 * line (the `session_meta` header) plus its stat, applies the same workspace
 * filter, and sorts newest-first — but skips the preview scan, the 64KB tail
 * window (last-user-message), and the title-sidecar open that the full listing
 * pays for.
 *
 * This is the source for content search: `searchSessionTranscripts` uses only
 * `sessionId` and the newest-first order, then re-opens each transcript itself,
 * so every extra byte the full listing reads is pure per-keystroke waste. Same
 * best-effort tolerance as the full listing — an unreadable or malformed file
 * is skipped, never thrown.
 */
export function listSessionHeaders(
  opts: ListSessionsOpts,
): SessionHeaderEntry[] {
  const limit = opts.limit ?? 10;

  let files: string[];
  try {
    files = readdirSync(opts.transcriptDir).filter((f) => f.endsWith(".jsonl"));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return [];
    throw err;
  }

  const entries: SessionHeaderEntry[] = [];
  for (const filename of files) {
    const sessionFile = join(opts.transcriptDir, filename);
    let mtime: Date;
    let size: number;
    try {
      const st = statSync(sessionFile);
      mtime = st.mtime;
      size = st.size;
    } catch {
      continue; // unreadable; skip
    }
    let firstLine: string;
    try {
      const fd = openSync(sessionFile, "r");
      try {
        const window = readWindow(fd, 0, Math.min(size, HEADER_SCAN_BYTES));
        firstLine = window.split("\n", 1)[0] ?? "";
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    const header = parseSessionHeader(firstLine);
    if (header === null) continue;
    if (
      opts.allWorkspaces !== true &&
      header.workspaceRoot !== opts.currentWorkspaceRoot
    ) {
      continue;
    }
    entries.push({
      sessionId: header.sessionId,
      workspaceRoot: header.workspaceRoot,
      startedAt: header.startedAt,
      mtime,
      ...(header.lang !== undefined ? { lang: header.lang } : {}),
    });
  }

  entries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return entries.slice(0, limit);
}
