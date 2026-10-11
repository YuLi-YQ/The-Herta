import type { DispatchJournalEntry } from "@herta/core";
import { describe, expect, it } from "vitest";
import { buildRecoverySummary } from "./recovery-summary.js";

const call = (id: string): DispatchJournalEntry => ({
  kind: "message",
  message: {
    role: "assistant",
    text: "",
    ts: "",
    toolCalls: [{ id, tool: "write_new_file", input: { path: `${id}.txt` } }],
  },
});
const result = (
  id: string,
  ok: boolean,
  code?: string,
): DispatchJournalEntry => ({
  kind: "message",
  message: {
    role: "tool",
    toolCallId: id,
    ts: "",
    result: {
      ok,
      summary: ok ? "written" : "failed",
      ...(code ? { error: { code, message: code, retryable: false } } : {}),
    },
  },
});

describe("journal recovery facts", () => {
  it("preserves failed run state and distinguishes interrupted read from completed work", () => {
    const entries: DispatchJournalEntry[] = [
      call("read"),
      {
        kind: "closer",
        callId: "read",
        outcome: "read_interrupted",
        result: { ok: false, summary: "read cancelled" },
      },
      { kind: "end", status: "failed" },
    ];
    const facts = buildRecoverySummary(entries, entries);
    expect(facts.state).toBe("failed");
    expect(facts.steps[0]?.outcome).toBe("cancelled");
    expect(facts.steps[0]?.phase).not.toBe("previously-completed");
  });
  it("separates previous success/failure from resumed and new actual results", () => {
    const before = [
      call("old"),
      result("old", true),
      call("failed"),
      result("failed", false, "write_failed"),
      call("pending"),
    ];
    const after = [
      ...before,
      result("pending", true),
      call("new"),
      result("new", true),
    ];
    expect(
      buildRecoverySummary(before, after).steps.map((s) => [
        s.callId,
        s.phase,
        s.outcome,
      ]),
    ).toEqual([
      ["old", "previously-completed", "succeeded"],
      ["failed", "previously-completed", "failed"],
      ["pending", "resumed", "succeeded"],
      ["new", "new", "succeeded"],
    ]);
  });
  it("denials and not-started calls cannot become completed; unresolved dispatch stays uncertain", () => {
    const entries: DispatchJournalEntry[] = [
      call("denied"),
      result("denied", false, "permission_denied"),
      call("queued"),
      call("unknown"),
      { kind: "dispatch", callIds: ["unknown"] },
    ];
    const facts = buildRecoverySummary(entries, entries, true);
    expect(facts.state).toBe("interrupted");
    expect(facts.steps.map((s) => [s.phase, s.outcome])).toEqual([
      ["not-executed", "denied"],
      ["not-executed", "pending"],
      ["uncertain", "unknown"],
    ]);
  });
  it("seal disk findings preserve previously applied write and externally changed uncertainty", () => {
    const entries: DispatchJournalEntry[] = [
      call("applied"),
      {
        kind: "closer",
        callId: "applied",
        outcome: "write_applied",
        result: { ok: true, summary: "disk hash matches" },
      },
      call("changed"),
      {
        kind: "closer",
        callId: "changed",
        outcome: "write_changed_since",
        result: { ok: false, summary: "external modification" },
      },
    ];
    expect(
      buildRecoverySummary(entries, entries).steps.map((s) => [
        s.phase,
        s.outcome,
      ]),
    ).toEqual([
      ["previously-completed", "succeeded"],
      ["uncertain", "unknown"],
    ]);
  });
});
