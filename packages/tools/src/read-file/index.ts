import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type {
  HertaTool,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { formatInputIssues } from "../input-issues.js";
import { resolveSafePath } from "../path-safety.js";
import { decodeUtf8 } from "../text-sniff.js";
import { readFileInputSchema, readFileJsonSchema } from "./schema.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SNIFF_BYTES = 4096;

export interface ReadFileData {
  content: string;
  totalLines: number;
  returnedRange: [number, number];
  /** `"utf-8 (lossy)"` when the bytes were not valid UTF-8 and unreadable
   *  ones became U+FFFD — such a file is readable but not editable. */
  encoding: "utf-8" | "utf-8 (lossy)";
}

export function readFileTool(): HertaTool {
  return {
    name: "read_file",
    readOnly: true,
    schema(): ToolSchema {
      return {
        name: "read_file",
        description:
          "Read a UTF-8 text file from the workspace, returning content with cat -n style line numbers. Supports offset/limit for paginated reads.",
        inputSchema: readFileJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<ReadFileData>> {
      const parsed = readFileInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: formatInputIssues(parsed.error),
            retryable: false,
          },
          suggestion: "usage: {path, offset?, limit?}",
          summary: "invalid input",
        };
      }
      const { path, offset = 1, limit = 2000 } = parsed.data;

      // allowHarnessReadPaths: read_file (alone) may follow the harness's
      // own "full output at .herta/logs/… / .herta/tool-results/…" pointers
      // (ADR 0025 slice 2). Mutating and listing tools keep the whole-tree
      // `.herta` denial.
      // allowAttachmentPaths: documents the 开拓者 handed over (ADR 0033).
      // Shared with show_excerpt, unlike the flag above — these are user
      // content, not harness internals, so presenting them back is the point.
      const safe = await resolveSafePath(ctx.workspaceRoot, path, {
        allowHarnessReadPaths: true,
        allowAttachmentPaths: true,
      });
      if (!safe.ok) {
        return {
          ok: false,
          error: { code: safe.code, message: safe.message, retryable: false },
          summary: `denied: ${safe.message}`,
        };
      }

      let info: Stats;
      try {
        info = await stat(safe.resolved);
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === "ENOENT") {
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
        return {
          ok: false,
          error: {
            code: "read_failed",
            message: (err as Error).message ?? "stat failed",
            retryable: false,
          },
          summary: "read failed",
        };
      }

      if (!info.isFile()) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: `not a file: ${safe.relative || path}`,
            retryable: false,
          },
          summary: `not a file: ${safe.relative || path}`,
        };
      }

      if (info.size > MAX_FILE_BYTES) {
        return {
          ok: false,
          error: {
            code: "file_too_large",
            message: `file is ${info.size} bytes (cap ${MAX_FILE_BYTES})`,
            retryable: false,
          },
          summary: `too large: ${safe.relative}`,
        };
      }

      let buf: Buffer;
      try {
        buf = await readFile(safe.resolved);
      } catch (err: unknown) {
        return {
          ok: false,
          error: {
            code: "read_failed",
            message: (err as Error).message ?? "read failed",
            retryable: false,
          },
          summary: "read failed",
        };
      }

      const sniff = buf.subarray(0, Math.min(SNIFF_BYTES, buf.length));
      if (sniff.includes(0)) {
        return {
          ok: false,
          error: {
            code: "binary_file",
            message: "NUL byte detected in first 4KB",
            retryable: false,
          },
          summary: `binary: ${safe.relative}`,
        };
      }

      const sha256 = createHash("sha256").update(buf).digest("hex");
      ctx.reads.record(safe.resolved, sha256);

      // The NUL sniff above only rules out binaries; it says nothing about
      // whether the bytes are UTF-8. When they are not (a GBK / Big5 /
      // Shift-JIS source), every unreadable byte decodes to U+FFFD — so SAY
      // so rather than handing back plausible-looking garbage the model would
      // go on to quote and reason about. The editors refuse such a file
      // outright; reading it stays possible, just honest (2026-08-24).
      const decoded = decodeUtf8(buf);
      const encoding = decoded.lossy ? "utf-8 (lossy)" : "utf-8";
      const lossyNote = decoded.lossy
        ? " — WARNING: not valid UTF-8; unreadable bytes shown as U+FFFD and this file cannot be edited"
        : "";
      let text = decoded.text;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

      if (text.length === 0) {
        return {
          ok: true,
          data: {
            content: "",
            totalLines: 0,
            returnedRange: [1, 0],
            encoding,
          },
          summary: `read ${safe.relative} (empty file)`,
        };
      }

      const lines = text.split("\n");
      const hasTrailingNewline = text.endsWith("\n");
      const totalLines = hasTrailingNewline ? lines.length - 1 : lines.length;

      const startIdx = offset - 1;
      if (startIdx >= totalLines) {
        return {
          ok: true,
          data: {
            content: "",
            totalLines,
            returnedRange: [offset, offset - 1],
            encoding,
          },
          summary: `read ${safe.relative} (offset ${offset} past end of ${totalLines} lines)`,
        };
      }
      const endIdx = Math.min(startIdx + limit, totalLines);
      const slice = lines.slice(startIdx, endIdx);
      const lastLineNo = endIdx;
      const padWidth = String(lastLineNo).length;
      const rendered = slice
        .map((line, i) => {
          const ln = (startIdx + i + 1).toString().padStart(padWidth, " ");
          return `${ln}\t${line}`;
        })
        .join("\n");
      const content =
        rendered + (endIdx < totalLines || hasTrailingNewline ? "\n" : "");

      const summaryRange =
        startIdx === 0 && endIdx === totalLines
          ? `entire file, ${totalLines} lines`
          : `lines ${offset}-${endIdx} of ${totalLines}`;

      return {
        ok: true,
        data: {
          content,
          totalLines,
          returnedRange: [offset, endIdx],
          encoding,
        },
        summary: `read ${safe.relative} (${summaryRange})${lossyNote}`,
      };
    },
  };
}
