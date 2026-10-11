import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHertaGitignore } from "../herta-dir-gitignore.js";
import type { ToolResult } from "../types/tool.js";
import { toolResultPayloadJson } from "./tool-message-content.js";

/**
 * Oversized tool-result persistence (ADR 0025 slice 2, CC pattern
 * re-derived): when one tool result's model-visible serialization exceeds
 * the threshold, the FULL payload is written to
 * `<workspace>/.herta/tool-results/<taskId>/<callId>.json` and the
 * transcript stores a preview + the path instead. The
 * `tool.call.finished` EVENT always carries the full result — the report
 * absorber, renderer projection, and evidence surfaces are untouched;
 * only what re-enters the model's prompt is bounded. read_file has a
 * read-only carve-out for `.herta/tool-results/` (path-safety.ts), so
 * the model can follow the pointer when the preview isn't enough.
 *
 * Thresholds: 24K chars (~6K tokens ASCII, ~24K tokens worst-case CJK)
 * catches the real offenders — git_diff can return up to 4 MiB, a
 * read_file of a big file up to ~10 MiB serialized — while normal edit
 * diffs and command tails pass through untouched. Preview 2K chars.
 */
export const PERSIST_RESULT_THRESHOLD_CHARS = 24_000;
export const PERSIST_PREVIEW_CHARS = 2_000;

export interface PersistOutcome {
  /** What the transcript (and thus every later prompt) stores. */
  transcriptResult: ToolResult;
  /** Workspace-relative POSIX path, when persistence engaged. */
  persistedPath?: string;
}

function safeFileStem(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  // All-dots stems ("."/"..") pass the character filter but are path
  // traversal as a SEGMENT — neutralize them. (Dots mixed with other
  // characters are harmless: no separator survives the replace, so the
  // stem can never split into segments.)
  if (cleaned.length === 0 || /^\.+$/.test(cleaned)) return "call";
  return cleaned;
}

export function persistOversizedResult(opts: {
  result: ToolResult;
  workspaceRoot: string;
  taskId: string;
  callId: string;
}): PersistOutcome {
  // The payload portion of the model's tool message — the one definition
  // the translate layer sends (tool-message-content.ts, 2026-09-03).
  const serialized = toolResultPayloadJson(opts.result);
  if (serialized.length <= PERSIST_RESULT_THRESHOLD_CHARS) {
    return { transcriptResult: opts.result };
  }

  const relDir = `.herta/tool-results/${safeFileStem(opts.taskId)}`;
  const relPath = `${relDir}/${safeFileStem(opts.callId)}.json`;
  try {
    const absDir = join(opts.workspaceRoot, ...relDir.split("/"));
    mkdirSync(absDir, { recursive: true });
    // These files are NOT redacted (see path-safety's note) — all the more
    // reason they must not reach the user's git history (audit BL6).
    ensureHertaGitignore(opts.workspaceRoot);
    writeFileSync(
      join(opts.workspaceRoot, ...relPath.split("/")),
      serialized,
      "utf8",
    );
  } catch {
    // Persistence must never break the turn: on any write failure the
    // full result passes through unbounded (the pre-flight budget's
    // phase-1 clearing still bounds it on LATER iterations).
    return { transcriptResult: opts.result };
  }

  const transcriptResult: ToolResult = {
    ok: opts.result.ok,
    summary: opts.result.summary,
    data: {
      persisted: true,
      path: relPath,
      originalChars: serialized.length,
      preview: serialized.slice(0, PERSIST_PREVIEW_CHARS),
      note: `full result too large for context — persisted to ${relPath}; read_file that path (offset/limit as needed) if the preview is not enough`,
    },
    ...(opts.result.error !== undefined ? { error: opts.result.error } : {}),
    ...(opts.result.suggestion !== undefined
      ? { suggestion: opts.result.suggestion }
      : {}),
    // A model-authored text (ADR 0040) is bounded by its tool and is what
    // the model must keep seeing; only the harness payload was oversized.
    ...(opts.result.modelText !== undefined
      ? { modelText: opts.result.modelText }
      : {}),
  };
  return { transcriptResult, persistedPath: relPath };
}
