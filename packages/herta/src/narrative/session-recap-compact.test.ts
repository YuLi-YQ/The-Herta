import type {
  ProviderAdapter,
  ProviderEvent,
  TerminalRecord,
  TerminalRecordBlock,
} from "@herta/core";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_CONFIG, type RecapCache } from "./session-recap.js";
import {
  makeRecapSummarize,
  prepareTurnRecap,
  type RecapOutcome,
  type RecapRuntime,
} from "./session-recap-runtime.js";

const prefix = { bio: "", env: "", fewShots: [] };
const signal = new AbortController().signal;
function record(n = 8): TerminalRecord {
  return Array.from({ length: n }, (_, n): TerminalRecordBlock[] => [
    { kind: "user", text: `Question ${n}` },
    { kind: "herta", surface: "speech", text: `Answer ${n}` },
  ]).flat();
}
function fixture() {
  let stored: RecapCache | null = null;
  const outcomes: RecapOutcome[] = [];
  const rt: RecapRuntime = {
    config: { ...DEFAULT_COMPACTION_CONFIG, enabled: true },
    guide: "",
    bio: "",
    lang: "en",
    failurePolicy: "full-context",
    manualRecentTurns: 4,
    summarize: vi.fn(
      async () => "A useful summary of the earlier questions and answers.",
    ),
    cacheRead: () => stored,
    cacheWrite: (cache) => {
      stored = cache;
    },
    onOutcome: (outcome) => outcomes.push(outcome),
    consecutiveFailures: 0,
    skippedWhileOpen: 0,
  };
  return { rt, outcomes, cache: () => stored };
}
describe("desktop compaction keeps complete context on failure", () => {
  it("manual compaction folds older small turns and timestamps the durable summary, unlike an ordinary under-threshold turn", async () => {
    const { rt, outcomes, cache } = fixture();
    expect(await prepareTurnRecap(record(), prefix, rt, false, signal)).toEqual(
      { recapBoundaryIndex: 0 },
    );
    const result = await prepareTurnRecap(record(), prefix, rt, true, signal);
    expect(result.recapBoundaryIndex).toBe(8);
    expect(cache()).toMatchObject({
      boundaryIndex: 8,
      generatedAt: expect.stringMatching(/^\d{4}-.*Z$/),
    });
    expect(outcomes.map((o) => o.status)).toEqual(["running", "completed"]);
    expect(await prepareTurnRecap(record(), prefix, rt, false, signal)).toEqual(
      result,
    );
  });
  it("does not invent completion when there is nothing older than the kept turns", async () => {
    const { rt, outcomes } = fixture();
    expect(await prepareTurnRecap(record(3), prefix, rt, true, signal)).toEqual(
      { recapBoundaryIndex: 0 },
    );
    expect(outcomes).toEqual([
      { status: "skipped", reason: "nothing_to_compact" },
    ]);
    expect(rt.summarize).not.toHaveBeenCalled();
  });
  it.each([
    "provider",
    "invalid_summary",
    "storage",
  ] as const)("a %s failure does not advance the boundary or overwrite the prior good cache", async (reason) => {
    const { rt, outcomes, cache } = fixture();
    await prepareTurnRecap(record(), prefix, rt, true, signal);
    const prior = cache();
    if (reason === "provider")
      rt.summarize = async () => {
        throw new Error("synthetic provider error");
      };
    if (reason === "invalid_summary") rt.summarize = async () => "";
    if (reason === "storage")
      rt.cacheWrite = () => {
        throw new Error("synthetic disk failure");
      };
    expect(
      await prepareTurnRecap(record(10), prefix, rt, true, signal),
    ).toEqual({ recapBoundaryIndex: 0 });
    expect(cache()).toBe(prior);
    expect(outcomes.at(-1)).toEqual({ status: "failed", reason });
  });
  it("does not elide raw input for a desktop summary and treats the open breaker as failure", async () => {
    const input = fixture();
    expect(
      await prepareTurnRecap(
        record(),
        prefix,
        {
          ...input.rt,
          config: { ...input.rt.config, maxSummarizerInputTokens: 1 },
        },
        true,
        signal,
      ),
    ).toEqual({ recapBoundaryIndex: 0 });
    expect(input.outcomes.at(-1)).toEqual({
      status: "failed",
      reason: "input_limit",
    });
    expect(input.rt.summarize).not.toHaveBeenCalled();
    const breaker = fixture();
    breaker.rt.consecutiveFailures = 3;
    expect(
      await prepareTurnRecap(record(), prefix, breaker.rt, true, signal),
    ).toEqual({ recapBoundaryIndex: 0 });
    expect(breaker.outcomes.at(-1)).toEqual({
      status: "failed",
      reason: "circuit_open",
    });
    expect(breaker.rt.summarize).not.toHaveBeenCalled();
  });
  it("does not save a late summary after cancellation or count it as provider failure", async () => {
    const { rt, outcomes, cache } = fixture();
    const aborted = new AbortController();
    rt.summarize = async () => {
      aborted.abort();
      return "Late synthetic summary";
    };
    expect(
      await prepareTurnRecap(record(), prefix, rt, true, aborted.signal),
    ).toEqual({ recapBoundaryIndex: 0 });
    expect(cache()).toBeNull();
    expect(rt.consecutiveFailures).toBe(0);
    expect(outcomes.at(-1)).toEqual({ status: "failed", reason: "cancelled" });
  });
  it.each([
    "error",
    "length",
    "tool_calls",
    "eof",
  ] as const)("does not treat plausible provider text with %s as a finished summary", async (finish) => {
    const provider: ProviderAdapter = {
      async *streamChat() {
        yield { type: "text-delta", text: "Looks like a summary" };
        if (finish !== "eof")
          yield { type: "finish", reason: finish } as ProviderEvent;
      },
    };
    await expect(
      makeRecapSummarize(provider)({ system: "", user: "", signal }),
    ).rejects.toThrow();
  });
});
