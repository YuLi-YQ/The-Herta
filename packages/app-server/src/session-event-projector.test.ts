import type { AgentEvent } from "@herta/core";
import { InMemoryEventBus } from "@herta/core";
import { projectBackendEvent } from "@herta/herta";
import { describe, expect, it } from "vitest";
import { SessionEventProjector } from "./session-event-projector.js";
import type { SpeechControlEvent } from "./types.js";

describe("SessionEventProjector — record stream fan-out", () => {
  it("delivers every emitted event to every subscriber in order", async () => {
    const projector = new SessionEventProjector({ queueCapacity: 100 });
    const subA: unknown[] = [];
    const subB: unknown[] = [];

    const consumeA = (async () => {
      for await (const ev of projector.subscribeRecord()) {
        subA.push(ev);
        if (subA.length >= 3) break;
      }
    })();
    const consumeB = (async () => {
      for await (const ev of projector.subscribeRecord()) {
        subB.push(ev);
        if (subB.length >= 3) break;
      }
    })();

    projector.emitRecord({
      kind: "block",
      blockId: "1",
      block: { kind: "user", text: "a" },
    });
    projector.emitRecord({
      kind: "block",
      blockId: "2",
      block: { kind: "user", text: "b" },
    });
    projector.emitRecord({
      kind: "block",
      blockId: "3",
      block: { kind: "user", text: "c" },
    });

    await Promise.all([consumeA, consumeB]);
    expect(subA).toHaveLength(3);
    expect(subB).toHaveLength(3);
    expect(subA).toEqual(subB);
  });

  it("breaking out of for-await tears down the subscription cleanly", async () => {
    const projector = new SessionEventProjector({ queueCapacity: 100 });
    // Subscribe first, then emit an event so next() resolves immediately,
    // allowing break to fire and trigger the return() cleanup path.
    const iter = projector.subscribeRecord();
    projector.emitRecord({
      kind: "block",
      blockId: "x",
      block: { kind: "user", text: "x" },
    });
    for await (const _ev of iter) {
      // Received the event; break immediately to test return() teardown.
      break;
    }
    // The projector should now have no subscribers — internal map empty.
    expect(projector.recordSubscriberCount()).toBe(0);
  });
});

describe("SessionEventProjector — bounded queue overflow", () => {
  it("emits a 'dropped' sentinel when a slow consumer overflows", async () => {
    const projector = new SessionEventProjector({ queueCapacity: 3 });
    const events: unknown[] = [];

    // Subscribe but don't start consuming immediately. Emit 5 events,
    // then drain — first event(s) should be dropped, with a 'dropped'
    // sentinel.
    const iter = projector.subscribeRecord();

    for (let i = 0; i < 5; i++) {
      projector.emitRecord({
        kind: "block",
        blockId: String(i),
        block: { kind: "user", text: String(i) },
      });
    }

    for await (const ev of iter) {
      events.push(ev);
      if (events.length >= 4) break; // 3 surviving + 1 dropped sentinel
    }

    // Expect: 2 oldest dropped, sentinel { kind: "dropped", count: 2 }
    // emitted, then the 3 most recent block events.
    const droppedSentinels = events.filter(
      (e) => (e as { kind: string }).kind === "dropped",
    );
    expect(droppedSentinels).toHaveLength(1);
    expect((droppedSentinels[0] as { count: number }).count).toBe(2);

    const blockEvents = events.filter(
      (e) => (e as { kind: string }).kind === "block",
    );
    expect(blockEvents).toHaveLength(3);
  });

  it("does not block emit on a slow consumer (projector keeps up with the runtime)", () => {
    const projector = new SessionEventProjector({ queueCapacity: 3 });
    projector.subscribeRecord(); // subscriber never drains

    // Emit 1000 events synchronously. None of these calls should
    // block, hang, or throw — overflow is the consumer's problem.
    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) {
      projector.emitRecord({
        kind: "block",
        blockId: String(i),
        block: { kind: "user", text: String(i) },
      });
    }
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(100); // sanity bound; in practice much smaller
  });
});

describe("SessionEventProjector — speech control stream fan-out", () => {
  it("fans speech control events to subscribeSpeech subscribers", async () => {
    const projector = new SessionEventProjector({ queueCapacity: 10 });
    const seen: SpeechControlEvent[] = [];
    const consumer = (async () => {
      for await (const e of projector.subscribeSpeech()) {
        seen.push(e);
        if (seen.length >= 1) break;
      }
    })();
    projector.emitSpeech({ kind: "retract" });
    await consumer;
    expect(seen[0]).toEqual({ kind: "retract" });
  });
});

describe("SessionEventProjector — bus event classification", () => {
  function busFor(): {
    bus: InMemoryEventBus<AgentEvent>;
    projector: SessionEventProjector;
  } {
    const bus = new InMemoryEventBus<AgentEvent>();
    const projector = new SessionEventProjector({ bus });
    return { bus, projector };
  }

  it("does NOT project permission.requested or permission.resolved to record", async () => {
    // onBusEvent no longer projects ANY backend event to the record stream; both events flow only as SessionAgentEvent (raw agent pass-through).
    const { bus, projector } = busFor();
    const recordEvents: unknown[] = [];
    const agentEvents: unknown[] = [];

    const r = (async () => {
      for await (const ev of projector.subscribeRecord()) {
        recordEvents.push(ev);
        break; // should not fire
      }
    })().catch(() => undefined);
    const a = (async () => {
      for await (const ev of projector.subscribeAgentEvents()) {
        agentEvents.push(ev);
        if (agentEvents.length >= 2) break;
      }
    })();

    bus.publish({
      type: "permission.requested",
      layer: "backend",
      request: {
        id: "p-1",
        call: {
          id: "c-1",
          tool: "run_command",
          input: { command: "rm -rf /" },
        },
        reason: "test",
        risk: "workspace_destructive",
      },
    });
    bus.publish({
      type: "permission.resolved",
      layer: "backend",
      id: "p-1",
      decision: "allow",
    });

    await a;
    // Give the record subscriber a chance to fire — it shouldn't.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(recordEvents).toHaveLength(0);
    expect(agentEvents).toHaveLength(2);
    void r;
  });

  it("projectBackendEvent never sets role (role is bridge-synthesized only)", () => {
    const cases: AgentEvent[] = [
      {
        type: "tool.call.started",
        layer: "backend",
        id: "t",
        tool: "write_new_file",
        inputSummary: "a.ts",
      },
      {
        type: "tool.call.finished",
        layer: "backend",
        id: "t",
        tool: "run_command",
        result: {
          ok: true,
          summary: "exit 0",
          data: {
            argv: ["x"],
            cwd: ".",
            exitCode: 0,
            signal: null,
            durationMs: 1,
            stdout: "out\n",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutBytes: 4,
            stderrBytes: 0,
            logPath: "l",
            timedOut: false,
          },
        },
      },
      {
        type: "patch.preview",
        layer: "backend",
        diff: "--- a\n+++ b",
        files: ["a.ts"],
      },
    ];
    for (const ev of cases) {
      const b = projectBackendEvent(ev);
      if (b !== null) expect((b as { role?: string }).role).toBeUndefined();
    }
  });
});

describe("SessionEventProjector — title stream", () => {
  it("delivers an emitted title event to a subscriber", async () => {
    const projector = new SessionEventProjector({ queueCapacity: 100 });
    const got: unknown[] = [];
    const consume = (async () => {
      for await (const ev of projector.subscribeTitle()) {
        got.push(ev);
        break;
      }
    })();
    projector.emitTitle({
      kind: "title",
      sessionId: "s",
      title: "排查失踪引用",
    });
    await consume;
    expect(got).toEqual([
      { kind: "title", sessionId: "s", title: "排查失踪引用" },
    ]);
  });
});
