import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "./herta-knowledge.js";
import { planDreamRun, runKnowledgeCli } from "./herta-knowledge.js";

describe("planDreamRun", () => {
  it("estimates calls per candidate episode and flags over-budget", () => {
    const plan = planDreamRun({ episodeCount: 10, budgetCapUsd: 0.01 });
    expect(plan.estimatedCalls).toBeGreaterThan(10);
    expect(plan.withinBudget).toBe(false);
  });
  it("is within budget when the cap is generous or unset", () => {
    expect(planDreamRun({ episodeCount: 1 }).withinBudget).toBe(true);
  });
});

/** Write a minimal valid v0.2 session JSONL file so listSessions + readSessionFile can parse it. */
function writeMinimalSession(
  transcriptDir: string,
  sessionId: string,
  workspaceRoot: string,
  lang?: "zh" | "en",
): void {
  const header = JSON.stringify({
    _kind: "session_meta",
    version: 1,
    sessionId,
    startedAt: new Date().toISOString(),
    workspaceRoot,
    ...(lang !== undefined ? { lang } : {}),
  });
  const userBlock = JSON.stringify({ kind: "user", text: "test message" });
  writeFileSync(
    join(transcriptDir, `${sessionId}.jsonl`),
    `${header}\n${userBlock}\n`,
    "utf8",
  );
}

describe("dream --limit wires loadedSessions to runDreamPass", () => {
  let ws: string;
  let transcriptDir: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "dream-cli-limit-"));
    transcriptDir = join(ws, ".herta", "transcript", "v2");
    mkdirSync(transcriptDir, { recursive: true });
    // Write 3 sessions so the full array has 3; with --limit 1 only 1 should reach runDreamPass.
    writeMinimalSession(transcriptDir, "sess-a", ws);
    writeMinimalSession(transcriptDir, "sess-b", ws);
    writeMinimalSession(transcriptDir, "sess-c", ws);
    process.env.HERTA_DEEPSEEK_API_KEY = "fake-key-for-test";
  });

  afterEach(() => {
    delete process.env.HERTA_DEEPSEEK_API_KEY;
    rmSync(ws, { recursive: true, force: true });
  });

  it("passes only 1 session to runDreamPass when --limit 1", async () => {
    const dreamPassSpy = vi.fn().mockResolvedValue({
      promoted: 0,
      skipped: 0,
      archived: 0,
      considered: 0,
    });
    const makeDeepSeekClient = vi.fn().mockReturnValue({ chatJson: vi.fn() });
    const deps: CliDeps = {
      runDreamPass: dreamPassSpy,
      makeDeepSeekClient,
    };

    const code = await runKnowledgeCli(
      ["dream", "--workspace", ws, "--limit", "1"],
      { cwd: ws, log: () => {}, err: () => {} },
      deps,
    );

    expect(code).toBe(0);
    expect(dreamPassSpy).toHaveBeenCalledTimes(1);
    const arg = dreamPassSpy.mock.calls[0]?.[0] as { sessions: unknown[] };
    expect(arg.sessions).toHaveLength(1);
  });
});

describe("dream groups sessions by header lang — one pass per language", () => {
  let ws: string;
  let transcriptDir: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "dream-cli-lang-"));
    transcriptDir = join(ws, ".herta", "transcript", "v2");
    mkdirSync(transcriptDir, { recursive: true });
    writeMinimalSession(transcriptDir, "sess-zh-1", ws); // legacy: no lang → zh
    writeMinimalSession(transcriptDir, "sess-zh-2", ws, "zh");
    writeMinimalSession(transcriptDir, "sess-en-1", ws, "en");
    process.env.HERTA_DEEPSEEK_API_KEY = "fake-key-for-test";
  });

  afterEach(() => {
    delete process.env.HERTA_DEEPSEEK_API_KEY;
    rmSync(ws, { recursive: true, force: true });
  });

  it("runs a zh pass over zh+legacy sessions and an en pass over en sessions", async () => {
    const dreamPassSpy = vi.fn().mockResolvedValue({
      promoted: 0,
      reinforced: 0,
      reconsolidated: 0,
      skipped: 0,
      archived: 0,
      considered: 0,
    });
    const deps: CliDeps = {
      runDreamPass: dreamPassSpy,
      makeDeepSeekClient: vi.fn().mockReturnValue({ chatJson: vi.fn() }),
    };

    const code = await runKnowledgeCli(
      ["dream", "--workspace", ws],
      { cwd: ws, log: () => {}, err: () => {} },
      deps,
    );

    expect(code).toBe(0);
    expect(dreamPassSpy).toHaveBeenCalledTimes(2);
    const calls = dreamPassSpy.mock.calls.map(
      (c) =>
        c[0] as {
          lang?: string;
          runId: string;
          sessions: { sessionId: string }[];
        },
    );
    const zhPass = calls.find((c) => c.lang === "zh");
    const enPass = calls.find((c) => c.lang === "en");
    expect(zhPass?.sessions.map((s) => s.sessionId).sort()).toEqual([
      "sess-zh-1",
      "sess-zh-2",
    ]);
    expect(enPass?.sessions.map((s) => s.sessionId)).toEqual(["sess-en-1"]);
    // Distinct per-pass runIds (tmp-file / log namespacing).
    expect(zhPass?.runId).not.toBe(enPass?.runId);
  });

  it("an aborted pass in either language exits 4 but still runs the other", async () => {
    const dreamPassSpy = vi
      .fn()
      .mockResolvedValueOnce({
        promoted: 0,
        reinforced: 0,
        reconsolidated: 0,
        skipped: 0,
        archived: 0,
        considered: 0,
        aborted: "transport",
      })
      .mockResolvedValueOnce({
        promoted: 1,
        reinforced: 0,
        reconsolidated: 0,
        skipped: 0,
        archived: 0,
        considered: 1,
      });
    const deps: CliDeps = {
      runDreamPass: dreamPassSpy,
      makeDeepSeekClient: vi.fn().mockReturnValue({ chatJson: vi.fn() }),
    };

    const code = await runKnowledgeCli(
      ["dream", "--workspace", ws],
      { cwd: ws, log: () => {}, err: () => {} },
      deps,
    );

    expect(code).toBe(4);
    expect(dreamPassSpy).toHaveBeenCalledTimes(2);
  });
});
