/**
 * Interrupt-during-permission-gate e2e (audit 2026-07-10, finding 4).
 *
 * Drives CodingAgentRuntime.runBrief with the REAL GUI permission stack
 * (RulePermissionEngine + OverlayAskResolver) and aborts while the gate is
 * pending — the "user presses Stop while the ApprovalPanel is up" path.
 *
 * Both failure modes this path has historically had must stay dead:
 *  - the HANG: the resolver ignored the signal, the ask promise never
 *    settled, runBrief never returned, and every later submit threw
 *    "a turn is already in progress" (second runBrief below proves no wedge);
 *  - the FABRICATED DENIAL: the hang fix settled the ask as "deny", so the
 *    loop emitted permission.resolved{deny} + a "User denied <tool>" tool
 *    result, and the false denial entered report.permissions, residualRisks,
 *    the done-marker's ↳ 风险 line, and the next dispatch's working history
 *    (the ADR-0010 poisoned-history class).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  BackendContextBuilder,
  CodingAgentRuntime,
  InMemoryEventBus,
  InMemoryToolRegistry,
  NoopMemoryManager,
  RulePermissionEngine,
  SessionApprovalCache,
} from "@herta/core";
import { FakeProvider } from "@herta/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverlayAskResolver } from "./overlay-ask-resolver.js";

describe("interrupt during a pending permission gate — e2e (audit finding 4)", () => {
  let wsRoot: string;
  beforeEach(() => {
    wsRoot = mkdtempSync(join(tmpdir(), "gate-int-ws-"));
  });
  afterEach(() => {
    rmSync(wsRoot, { recursive: true, force: true });
  });

  it("runBrief settles as an interrupt with no fabricated denial, and the runtime does not wedge", async () => {
    let overlayCleared = false;
    const resolver = new OverlayAskResolver({
      setPendingOverlay: () => {},
      clearOverlay: () => {
        overlayCleared = true;
      },
      cache: new SessionApprovalCache(),
    });
    const permissions = new RulePermissionEngine({ ask: resolver });
    permissions.registerRule("edit_file", () => ({
      kind: "ask",
      reason: "writes a file",
      risk: "workspace_write",
    }));

    const tools = new InMemoryToolRegistry();
    tools.register({
      name: "edit_file",
      schema: () => ({ name: "edit_file", description: "", inputSchema: {} }),
      run: async () => ({ ok: true, summary: "should never run" }),
    });

    // turns[0] feeds the interrupted brief; turns[1] feeds the follow-up
    // brief that proves the runtime is not wedged.
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: { id: "c1", tool: "edit_file", input: { path: "x.ts" } },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
    });

    const bus = new InMemoryEventBus<AgentEvent>();
    const runtime = new CodingAgentRuntime({
      sessionId: "s",
      provider,
      tools,
      permissions,
      backendBuilder: new BackendContextBuilder({ tools }),
      bus,
      clock: () => new Date("2026-07-10T00:00:00.000Z"),
      workspaceRoot: wsRoot,
      memory: new NoopMemoryManager(),
    });

    const ac = new AbortController();
    const events: AgentEvent[] = [];
    bus.onAny((ev) => {
      events.push(ev);
      if (ev.type === "permission.requested") {
        // Stop clicked while the ApprovalPanel is up — same abort shape as
        // session.interrupt().
        ac.abort(
          new DOMException("Interrupted by session.interrupt()", "AbortError"),
        );
      }
    });

    const report = await runtime.runBrief(
      { taskId: "t-int" },
      { signal: ac.signal, userMessages: [{ text: "edit x" }] },
    );

    // Settled (no hang), as an interrupt — not a decision, and not a
    // FAILURE either (audit 2026-07-24, 1.4): the loop already distinguishes
    // `error.kind: "interrupted"`, and the runtime now keeps that distinction
    // instead of collapsing every turn.failed into one boolean. Previously
    // this assertion pinned the very conflation that made a user's Stop
    // durably read as 板砖 失败 in the shared record.
    expect(report.status).toBe("interrupted");
    expect(report.permissions).toEqual([]);
    expect(events.map((e) => e.type)).not.toContain("permission.resolved");
    expect(
      events.some(
        (e) =>
          e.type === "tool.call.finished" &&
          !e.result.ok &&
          e.result.error?.code === "permission_denied",
      ),
    ).toBe(false);
    expect(report.residualRisks.join(" ")).not.toMatch(/User denied/);
    const failed = events.find((e) => e.type === "turn.failed");
    expect(failed).toBeDefined();
    if (failed?.type === "turn.failed") {
      expect(failed.error.kind).toBe("interrupted");
    }
    // The overlay cleared so the renderer unlocks.
    expect(overlayCleared).toBe(true);

    // No wedge: a second brief starts and completes immediately.
    const second = await runtime.runBrief(
      { taskId: "t-next" },
      { userMessages: [{ text: "hi" }] },
    );
    expect(second.status).toBe("partial");
  });
});
