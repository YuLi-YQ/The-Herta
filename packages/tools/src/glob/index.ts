import { stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  HertaTool,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { formatInputIssues } from "../input-issues.js";
import { resolveSafePath } from "../path-safety.js";
import { walkDir } from "../walker.js";
import { globToRegExp } from "./glob-to-regex.js";
import { globInputSchema, globJsonSchema } from "./schema.js";

/** Hard cap on candidates collected during the walk — a "**" over a huge
 *  tree stops here and reports truncation instead of statting the world.
 *
 *  Note what a capped scan costs: the walker is name-sorted depth-first, so
 *  the survivors are the alphabetically-first 5000, and the mtime sort below
 *  only orders THOSE. The result is not the newest 5000 files (audit BL23) —
 *  the summary says so rather than the tool pretending otherwise. */
const SCAN_MATCH_CAP = 5_000;

export interface GlobFileEntry {
  path: string;
  /** File mtime (ms epoch); 0 when stat failed after matching. */
  mtimeMs: number;
}

export interface GlobData {
  files: GlobFileEntry[];
  truncated: boolean;
}

/**
 * Find files by glob pattern, newest first (ADR 0025 slice 3 — the CC
 * mtime-sort pattern re-derived: recently-touched files are almost always
 * the relevant ones). Same walker and per-entry safety filters as
 * search_text: skips .git/node_modules/dist/build/coverage and
 * harness dirs, drops credential-shaped entries, never follows directory
 * symlinks.
 */
export function globTool(): HertaTool {
  return {
    name: "glob",
    readOnly: true,
    schema(): ToolSchema {
      return {
        name: "glob",
        description:
          "Find files by glob pattern, matched against the search-root-relative path. " +
          'Supports ** (any depth), * (within a segment), ?, [..] classes, {a,b} alternation — e.g. "**/*.ts", "src/**/*.test.tsx", "{packages,scripts}/**/*.mjs". ' +
          "Results are sorted by modification time, NEWEST FIRST. " +
          "Skips .git/node_modules/dist/build/coverage. Use search_text to search contents.",
        inputSchema: globJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<GlobData>> {
      const parsed = globInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: formatInputIssues(parsed.error),
            retryable: false,
          },
          suggestion: "usage: {pattern, path?, maxResults?}",
          summary: "invalid input",
        };
      }
      const { pattern, path = ".", maxResults = 500 } = parsed.data;

      const regex = globToRegExp(pattern);
      if (regex === null) {
        return {
          ok: false,
          error: {
            code: "invalid_pattern",
            message: `malformed glob pattern: ${pattern}`,
            retryable: false,
          },
          summary: "invalid pattern",
        };
      }

      // The redacted log directory is discoverable BY NAME here (ADR 0036):
      // the receipts are `<uuid>-call_NN_<op>.log`, unguessable without a
      // listing, and since list_files left (2026-09-18, ADR 0067) a glob
      // rooted at `.herta/logs` is the listing. Nothing else under `.herta`
      // opens — the walker never descends into it from the workspace root.
      const safe = await resolveSafePath(ctx.workspaceRoot, path, {
        allowEvidenceDiscoveryPaths: true,
      });
      if (!safe.ok) {
        return {
          ok: false,
          error: { code: safe.code, message: safe.message, retryable: false },
          summary: `denied: ${safe.message}`,
        };
      }
      let rootInfo: Awaited<ReturnType<typeof stat>>;
      try {
        rootInfo = await stat(safe.resolved);
      } catch {
        return {
          ok: false,
          error: {
            code: "not_found",
            message: `not found: ${safe.relative || path}`,
            retryable: false,
          },
          summary: `not found: ${safe.relative || path}`,
        };
      }
      if (!rootInfo.isDirectory()) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: `not a directory: ${safe.relative || path}`,
            retryable: false,
          },
          summary: "not a directory",
        };
      }

      const rootRel = safe.relative;
      const matched: string[] = [];
      let scanCapped = false;

      for await (const entry of walkDir(ctx.workspaceRoot, safe.resolved, {
        recursive: true,
        signal: ctx.signal,
      })) {
        if (entry.type !== "file") continue;
        // Match against the SEARCH-ROOT-relative path so "src" + "**/*.ts"
        // behaves like running the glob inside src/.
        const target =
          rootRel === "" ? entry.path : entry.path.slice(rootRel.length + 1);
        if (!regex.test(target)) continue;
        // Same per-entry gate as search_text: realpath + credential denylist.
        // The discovery carve-out must match the root gate above, or a glob
        // INTO the log dir would pass the root check and then silently drop
        // every entry it walked.
        const safeEntry = await resolveSafePath(ctx.workspaceRoot, entry.path, {
          allowEvidenceDiscoveryPaths: true,
        });
        if (!safeEntry.ok) continue;
        matched.push(entry.path);
        if (matched.length >= SCAN_MATCH_CAP) {
          scanCapped = true;
          break;
        }
      }

      const withMtime: GlobFileEntry[] = [];
      for (const relPath of matched) {
        ctx.signal.throwIfAborted();
        let mtimeMs = 0;
        try {
          const s = await stat(join(ctx.workspaceRoot, ...relPath.split("/")));
          mtimeMs = s.mtimeMs;
        } catch {
          // raced deletion — keep the entry with mtime 0 (sorts last)
        }
        withMtime.push({ path: relPath, mtimeMs });
      }

      withMtime.sort((a, b) => {
        if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
        return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
      });

      const truncated = scanCapped || withMtime.length > maxResults;
      const files = withMtime.slice(0, maxResults);

      // "newest first" is only true of the WHOLE match set when the scan did
      // not hit the cap (audit BL23). The walker is name-sorted depth-first,
      // so a capped scan keeps the alphabetically-first 5000 and then sorts
      // those by mtime — the genuinely newest file may never have been
      // reached. Saying so is the fix: sorting the true newest would mean
      // statting every match, which is exactly what the cap exists to avoid.
      const summary = scanCapped
        ? `matched ${files.length}+ files for ${pattern} (scan hit the ${SCAN_MATCH_CAP}-file cap, so these are the first ${SCAN_MATCH_CAP} by path, newest-first among those — narrow the pattern for a true newest-first)`
        : truncated
          ? `matched ${files.length}+ files for ${pattern} (truncated; narrow the pattern)`
          : files.length === 0
            ? `matched 0 files for ${pattern}`
            : `matched ${files.length} files for ${pattern} (newest first)`;

      return { ok: true, data: { files, truncated }, summary };
    },
  };
}
