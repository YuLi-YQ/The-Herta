import type {
  DispatchJournalEntry,
  RecoverySummary,
  ToolCallRequest,
  ToolResult,
} from "@herta/core";

/** This projection reads durable harness entries, never a model's account of time. */
export function buildRecoverySummary(
  before: readonly DispatchJournalEntry[],
  after: readonly DispatchJournalEntry[],
  interrupted = false,
): RecoverySummary {
  const calls = new Map<string, ToolCallRequest>();
  const prior = new Set<string>();
  const results = new Map<string, ToolResult>();
  const priorResults = new Set<string>();
  const closers = new Map<string, string>();
  const dispatched = new Set<string>();
  const collect = (entries: readonly DispatchJournalEntry[], old: boolean) => {
    for (const entry of entries) {
      if (entry.kind === "dispatch")
        for (const id of entry.callIds) dispatched.add(id);
      if (entry.kind === "closer") {
        results.set(entry.callId, entry.result);
        closers.set(entry.callId, entry.outcome);
      }
      if (entry.kind !== "message") continue;
      if (entry.message.role === "assistant")
        for (const call of entry.message.toolCalls) {
          calls.set(call.id, call);
          if (old) prior.add(call.id);
        }
      if (entry.message.role === "tool") {
        results.set(entry.message.toolCallId, entry.message.result);
        if (old) priorResults.add(entry.message.toolCallId);
      }
    }
  };
  collect(before, true);
  collect(after, false);
  const steps: RecoverySummary["steps"][number][] = [...calls.values()].map(
    (call) => {
      const result = results.get(call.id);
      const cutoff = closers.get(call.id);
      const code = result?.error?.code;
      const uncertain =
        cutoff === "outcome_unknown" ||
        cutoff === "write_changed_since" ||
        code === "stopped_outcome_unknown" ||
        (!result && dispatched.has(call.id));
      const denied = code === "permission_denied";
      const notExecuted =
        cutoff === "not_started" ||
        cutoff === "read_interrupted" ||
        cutoff === "write_not_applied" ||
        cutoff === "state_not_applied" ||
        denied ||
        code === "journal_unavailable" ||
        !!call.malformedArgs;
      const outcome = uncertain
        ? "unknown"
        : denied
          ? "denied"
          : cutoff === "read_interrupted" ||
              code === "cancelled" ||
              code === "aborted"
            ? "cancelled"
            : result?.ok
              ? "succeeded"
              : result
                ? "failed"
                : "pending";
      const phase = uncertain
        ? "uncertain"
        : notExecuted
          ? "not-executed"
          : priorResults.has(call.id) || cutoff === "write_applied"
            ? "previously-completed"
            : !result && dispatched.has(call.id)
              ? "uncertain"
              : !result
                ? "not-executed"
                : prior.has(call.id)
                  ? "resumed"
                  : "new";
      const input =
        call.input && typeof call.input === "object"
          ? (call.input as Record<string, unknown>)
          : {};
      const target =
        typeof input.path === "string"
          ? input.path
          : typeof input.command === "string"
            ? input.command
            : Array.isArray(input.argv)
              ? input.argv.filter((v) => typeof v === "string").join(" ")
              : undefined;
      return {
        callId: call.id,
        tool: call.tool,
        ...(target ? { target } : {}),
        phase,
        outcome,
        summary:
          result?.summary ??
          (dispatched.has(call.id)
            ? "No durable result; execution outcome is unknown."
            : "No execution recorded."),
      };
    },
  );
  const start =
    after.find((entry) => entry.kind === "start") ??
    before.find((entry) => entry.kind === "start");
  const end = [...after].reverse().find((entry) => entry.kind === "end");
  const state = interrupted
    ? "interrupted"
    : end?.kind === "end" && end.status === "interrupted"
      ? "interrupted"
      : end?.kind === "end" &&
          (end.status === "failed" || end.status === "blocked")
        ? end.status
        : steps.some(
              (step) => step.phase === "uncertain" || step.outcome === "denied",
            )
          ? "blocked"
          : steps.some((step) => step.outcome === "failed")
            ? "failed"
            : end
              ? "completed"
              : "running";
  return {
    version: 1,
    runId: start?.kind === "start" ? start.taskId : "unavailable",
    state,
    steps,
  };
}
