import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolResult } from "../types/tool.js";
import {
  PERSIST_PREVIEW_CHARS,
  PERSIST_RESULT_THRESHOLD_CHARS,
  persistOversizedResult,
} from "./tool-result-persistence.js";

let ws: string | undefined;
afterEach(() => {
  if (ws !== undefined) rmSync(ws, { recursive: true, force: true });
  ws = undefined;
});

function mkWs(): string {
  ws = mkdtempSync(join(tmpdir(), "herta-persist-"));
  return ws;
}

const small: ToolResult = {
  ok: true,
  summary: "read x.ts",
  data: { content: "short" },
};

describe("persistOversizedResult", () => {
  it("passes small results through untouched, no file written", () => {
    const root = mkWs();
    const out = persistOversizedResult({
      result: small,
      workspaceRoot: root,
      taskId: "t1",
      callId: "c1",
    });
    expect(out.persistedPath).toBeUndefined();
    expect(out.transcriptResult).toBe(small);
  });

  it("persists an oversized payload and stores preview + path in the transcript variant", () => {
    const root = mkWs();
    const big = "z".repeat(PERSIST_RESULT_THRESHOLD_CHARS + 5_000);
    const result: ToolResult = {
      ok: true,
      summary: "diff of everything",
      data: { diff: big },
    };
    const out = persistOversizedResult({
      result,
      workspaceRoot: root,
      taskId: "task-abc",
      callId: "call_01",
    });
    expect(out.persistedPath).toBe(".herta/tool-results/task-abc/call_01.json");
    // File holds the FULL serialized payload.
    const onDisk = readFileSync(
      join(root, ".herta", "tool-results", "task-abc", "call_01.json"),
      "utf8",
    );
    expect(onDisk).toContain(big);
    // Transcript variant: same ok/summary, bounded data with pointer.
    const t = out.transcriptResult;
    expect(t.ok).toBe(true);
    expect(t.summary).toBe("diff of everything");
    const data = t.data as {
      persisted: boolean;
      path: string;
      preview: string;
      note: string;
    };
    expect(data.persisted).toBe(true);
    expect(data.path).toBe(out.persistedPath);
    expect(data.preview.length).toBe(PERSIST_PREVIEW_CHARS);
    expect(data.note).toContain("read_file");
  });

  it("keeps error + suggestion on an oversized failure result", () => {
    const root = mkWs();
    const result: ToolResult = {
      ok: false,
      summary: "failed big",
      data: { partial: "y".repeat(PERSIST_RESULT_THRESHOLD_CHARS + 100) },
      error: { code: "boom", message: "kaput", retryable: false },
      suggestion: "try smaller",
    };
    const out = persistOversizedResult({
      result,
      workspaceRoot: root,
      taskId: "t",
      callId: "c",
    });
    expect(out.persistedPath).toBeDefined();
    expect(out.transcriptResult.error?.code).toBe("boom");
    expect(out.transcriptResult.suggestion).toBe("try smaller");
  });

  it("sanitizes hostile call ids into safe filenames", () => {
    const root = mkWs();
    const result: ToolResult = {
      ok: true,
      summary: "big",
      data: { x: "q".repeat(PERSIST_RESULT_THRESHOLD_CHARS + 1) },
    };
    const out = persistOversizedResult({
      result,
      workspaceRoot: root,
      taskId: "..",
      callId: "../../etc/passwd",
    });
    // All-dot stems neutralize to "call"; separators collapse to
    // underscores — everything stays inside .herta/tool-results/.
    expect(out.persistedPath).toBe(
      ".herta/tool-results/call/.._.._etc_passwd.json",
    );
    expect(
      readFileSync(
        join(root, ".herta", "tool-results", "call", ".._.._etc_passwd.json"),
        "utf8",
      ).length,
    ).toBeGreaterThan(PERSIST_RESULT_THRESHOLD_CHARS);
  });

  it("passes through unbounded on a write failure instead of breaking the turn", () => {
    const root = mkWs();
    // Make `.herta` a FILE so mkdir of .herta/tool-results fails.
    writeFileSync(join(root, ".herta"), "not a dir", "utf8");
    const result: ToolResult = {
      ok: true,
      summary: "big",
      data: { x: "q".repeat(PERSIST_RESULT_THRESHOLD_CHARS + 1) },
    };
    const out = persistOversizedResult({
      result,
      workspaceRoot: root,
      taskId: "t",
      callId: "c",
    });
    expect(out.persistedPath).toBeUndefined();
    expect(out.transcriptResult).toBe(result);
  });
});
