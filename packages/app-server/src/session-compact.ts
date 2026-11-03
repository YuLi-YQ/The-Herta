import {
  type CompactAction,
  type CompactReply,
  type CompactView,
  parseCompactAction,
  type TerminalRecord,
} from "@herta/core";
import type { RecapOutcome, RecapRuntime } from "@herta/herta";

/** Pending requests are deliberately scoped to this open session; only successful recaps persist. */
export class SessionCompactController {
  readonly runtime: RecapRuntime;
  private revision = 0;
  private pending = false;
  private status: CompactView["status"] = "idle";
  private reason: CompactView["reason"];
  constructor(
    base: RecapRuntime,
    private readonly record: () => TerminalRecord,
    private readonly lang: "zh" | "en",
  ) {
    this.runtime = {
      ...base,
      failurePolicy: "full-context",
      manualRecentTurns: 4,
      onOutcome: (outcome) => this.observe(outcome),
      cacheInvalidate: () => {
        if (!base.cacheInvalidate)
          throw new Error("Recap invalidation is unavailable");
        base.cacheInvalidate();
        this.status = this.pending ? "scheduled" : "idle";
        this.reason = undefined;
        this.revision++;
      },
    };
  }
  view(): CompactView {
    const record = this.record();
    const cache = this.runtime.cacheRead();
    const valid =
      cache &&
      cache.lang === this.lang &&
      Number.isSafeInteger(cache.boundaryIndex) &&
      cache.boundaryIndex > 0 &&
      cache.boundaryIndex < record.length &&
      record[cache.boundaryIndex]?.kind === "user" &&
      cache.recapText.trim() &&
      cache.recapText.length <= this.runtime.config.maxRecapChars * 2;
    const lostCache = this.status === "completed" && !valid;
    return {
      revision: this.revision,
      status: lostCache
        ? "failed"
        : this.status === "idle" && valid
          ? "completed"
          : this.status,
      ...(lostCache
        ? { reason: "storage" as const }
        : this.reason
          ? { reason: this.reason }
          : {}),
      scheduledPersistent: false,
      recap: valid
        ? {
            text: cache.recapText,
            boundaryIndex: cache.boundaryIndex,
            generatedAt: cache.generatedAt ?? null,
          }
        : null,
      recordLength: record.length,
    };
  }
  update(expected: number, input: CompactAction): CompactReply {
    const view = this.view(),
      action = parseCompactAction(input);
    if (!action || !Number.isSafeInteger(expected) || expected < 0)
      return { ok: false, reason: "invalid", view };
    if (expected !== this.revision)
      return { ok: false, reason: "conflict", view };
    if (this.status === "running") return { ok: false, reason: "busy", view };
    if (action.type === "cancel" && !this.pending)
      return { ok: false, reason: "invalid", view };
    const pending = action.type === "schedule";
    if (pending === this.pending) return { ok: true, view };
    this.pending = pending;
    this.status = pending ? "scheduled" : "idle";
    this.reason = undefined;
    this.revision++;
    return { ok: true, view: this.view() };
  }
  /** Called only when the driver actually reaches the next context preparation boundary. */
  consume = (): boolean => {
    if (!this.pending) return false;
    this.pending = false;
    this.status = "running";
    this.reason = undefined;
    this.revision++;
    return true;
  };
  private observe(outcome: RecapOutcome): void {
    this.status = outcome.status;
    this.reason = "reason" in outcome ? outcome.reason : undefined;
    this.revision++;
  }
}
