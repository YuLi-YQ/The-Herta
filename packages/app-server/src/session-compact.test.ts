import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRequest, ProviderConfig } from "@herta/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionHost } from "./session-host.js";
import { removeTmpDir } from "./testing/tmp-workspace.js";
import type { AppServerConfig, SessionHost } from "./types.js";

const script = vi.hoisted(() => ({
  systems: [] as string[],
  hold: null as Promise<void> | null,
  failDelete: false,
  failWrite: false,
  requests: [] as ModelRequest[],
  summaryMode: "ok",
  ask: false,
}));
vi.mock("@herta/core", async (original) => {
  const actual = await original<typeof import("@herta/core")>();
  return {
    ...actual,
    writeFileAtomicSync: (
      ...args: Parameters<typeof actual.writeFileAtomicSync>
    ) => {
      if (script.failWrite && String(args[0]).includes("compaction"))
        throw new Error("synthetic recap write failure");
      return actual.writeFileAtomicSync(...args);
    },
    deleteSessionFiles: (
      ...args: Parameters<typeof actual.deleteSessionFiles>
    ) => {
      if (script.failDelete) throw new Error("synthetic delete failure");
      return actual.deleteSessionFiles(...args);
    },
  };
});
vi.mock("@herta/providers", async (original) => {
  const actual = await original<typeof import("@herta/providers")>();
  return {
    ...actual,
    createProtocolAdapter: (config: ProviderConfig) => ({
      protocol: config.protocol,
      async *stream(request: ModelRequest) {
        script.systems.push(request.system);
        script.requests.push(request);
        if (request.tools.length === 0) {
          if (script.hold) await script.hold;
          request.signal.throwIfAborted();
          if (script.summaryMode === "error")
            throw new Error("synthetic summary failure");
          yield {
            type: "text-delta",
            text:
              script.summaryMode === "empty"
                ? ""
                : "SUMMARY-131: The earlier synthetic questions were reviewed.",
          } as const;
          if (script.summaryMode === "eof") return;
          yield {
            type: "finished",
            reason: script.summaryMode === "length" ? "length" : "stop",
          } as const;
          return;
        }
        if (
          script.ask &&
          !request.messages.some(
            (m) => m.role === "tool" && m.toolCallId === "ask",
          )
        ) {
          yield {
            type: "tool-call-ready",
            call: {
              id: "ask",
              tool: "request_user_input",
              input: {
                questions: [
                  {
                    id: "q",
                    prompt: "Choose the next step",
                    kind: "text",
                    required: true,
                    allowText: true,
                    options: [],
                  },
                ],
              },
            },
          } as const;
          yield { type: "finished", reason: "tool-calls" } as const;
          return;
        }
        yield { type: "text-delta", text: "Synthetic reply." } as const;
        yield { type: "finished", reason: "stop" } as const;
      },
    }),
  };
});
const roots: string[] = [];
const hosts: SessionHost[] = [];
beforeEach(() => {
  script.systems = [];
  script.hold = null;
  script.failDelete = false;
  script.failWrite = false;
  script.requests = [];
  script.summaryMode = "ok";
  script.ask = false;
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.closeActiveSession();
  for (const root of roots.splice(0)) await removeTmpDir(root);
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "herta-compact-session-"));
  roots.push(root);
  const provider: ProviderConfig = {
    id: "goal-test",
    name: "Goal test",
    protocol: "openai-chat-completions",
    baseURL: "https://example.invalid/v1",
    authentication: "none",
    credentialRef: null,
    allowRemoteHTTP: false,
    revision: 1,
    models: [
      {
        id: "m",
        source: "manual",
        capabilities: {
          streaming: "supported",
          tools: "supported",
          images: "supported",
          reasoning: "unknown",
        },
        validation: {
          state: "tools-available",
          protocol: "openai-chat-completions",
          providerRevision: 1,
        },
      },
    ],
    defaults: { model: "m", timeoutMs: 1000 },
  };
  const config: AppServerConfig = {
    workspaceRoot: root,
    transcriptDir: join(root, ".herta", "transcript", "v2"),
    projectMemoryDir: join(root, ".herta", "memory"),
    userMemoryDir: join(root, ".herta", "user-memory"),
    narrativeDir: join(root, ".herta", "narrative"),
    providers: {
      deepseekApiKey: "",
      actorModel: "unused",
      backendModel: "unused",
      routerModel: "unused",
    },
    neutralProviders: {
      resolveTurn: async (sessionId, turnId) => ({
        snapshot: {
          sessionId,
          turnId,
          persona: provider,
          executor: provider,
          bindings: {
            persona: { providerId: provider.id, modelId: "m" },
            executor: { providerId: provider.id, modelId: "m" },
          },
        },
        personaKey: null,
        executorKey: null,
      }),
    },
  };
  const host = createSessionHost(config);
  hosts.push(host);
  return { root, host };
}

function view(session: Awaited<ReturnType<SessionHost["createSession"]>>) {
  const result = session.getCompact!();
  if (!result.ok) throw new Error(result.reason);
  return result.view;
}
async function seed(
  session: Awaited<ReturnType<SessionHost["createSession"]>>,
) {
  for (let n = 0; n < 6; n++) await session.submitText(`QUESTION-${n}-131`);
  script.requests = [];
}
describe("workbench /compact with real Session and neutral providers", () => {
  it("queues/cancels without calling a model, rejects stale actions, and does not retain a pending request across reopen", async () => {
    const { root, host } = fixture();
    const s = await host.createSession({ backendWorkspace: root });
    expect(view(s)).toMatchObject({
      status: "idle",
      scheduledPersistent: false,
      recap: null,
    });
    expect(s.updateCompact!(0, { type: "schedule" })).toMatchObject({
      ok: true,
      view: { status: "scheduled", revision: 1 },
    });
    expect(s.updateCompact!(0, { type: "cancel" })).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(s.updateCompact!(1, { type: "cancel" })).toMatchObject({
      ok: true,
      view: { status: "idle" },
    });
    expect(script.requests).toEqual([]);
    s.updateCompact!(view(s).revision, { type: "schedule" });
    await host.closeActiveSession();
    expect(s.getCompact!()).toEqual({ ok: false, reason: "no_target" });
    const reopened = await host.openSession({ sessionId: s.sessionId });
    expect(view(reopened).status).toBe("idle");
    expect(script.requests).toEqual([]);
  });
  it("reports a short conversation as skipped without a fabricated summary or additional model call", async () => {
    const { root, host } = fixture();
    const s = await host.createSession({ backendWorkspace: root });
    s.updateCompact!(0, { type: "schedule" });
    await s.submitText("short first turn");
    expect(view(s)).toMatchObject({
      status: "skipped",
      reason: "nothing_to_compact",
      recap: null,
    });
    expect(script.requests).toHaveLength(1);
  });
  it("creates and reloads a timestamped recap while preserving every original record and using the correct remaining messages", async () => {
    const { root, host } = fixture();
    const s = await host.createSession({ backendWorkspace: root });
    await seed(s);
    const original = [...s.record];
    s.updateCompact!(0, { type: "schedule" });
    await s.submitText("NEWEST-131");
    const completed = view(s);
    expect(completed).toMatchObject({
      status: "completed",
      recap: {
        boundaryIndex: 6,
        text: expect.stringContaining("SUMMARY-131"),
        generatedAt: expect.stringMatching(/^\d{4}-.*Z$/),
      },
    });
    expect(s.record.slice(0, original.length)).toEqual(original);
    const recap = script.requests.find(
      (request) => request.tools.length === 0,
    )!;
    expect(JSON.stringify(recap.messages)).toContain("QUESTION-0-131");
    expect(recap.options.webSearch).toBe(false);
    const persona = script.requests.at(-1)!;
    expect(JSON.stringify(persona.messages)).toContain("SUMMARY-131");
    expect(JSON.stringify(persona.messages)).not.toContain("QUESTION-0-131");
    expect(JSON.stringify(persona.messages)).toContain("QUESTION-3-131");
    expect(JSON.stringify(persona.messages)).toContain("NEWEST-131");
    await host.closeActiveSession();
    const reopened = await host.openSession({ sessionId: s.sessionId });
    expect(view(reopened).recap).toEqual(completed.recap);
    expect(view(reopened).status).toBe("completed");
    script.requests = [];
    await reopened.submitText("after reopen");
    expect(script.requests).toHaveLength(1);
    expect(JSON.stringify(script.requests[0]!.messages)).toContain(
      "SUMMARY-131",
    );
  });
  it.each([
    "error",
    "length",
    "eof",
    "empty",
  ])("uses full context after summary %s and never reports completion", async (mode) => {
    const { root, host } = fixture();
    const s = await host.createSession({ backendWorkspace: root });
    await seed(s);
    script.summaryMode = mode;
    s.updateCompact!(0, { type: "schedule" });
    await s.submitText("continue despite unavailable summary");
    expect(view(s)).toMatchObject({
      status: "failed",
      reason: mode === "empty" ? "invalid_summary" : "provider",
      recap: null,
    });
    expect(JSON.stringify(script.requests.at(-1)!.messages)).toContain(
      "QUESTION-0-131",
    );
    expect(
      existsSync(join(root, ".herta", "compaction", `${s.sessionId}.json`)),
    ).toBe(false);
  });
  it("keeps the previous viewable cache when a new save fails but sends full context for the failed compaction turn", async () => {
    const { root, host } = fixture();
    const s = await host.createSession({ backendWorkspace: root });
    await seed(s);
    s.updateCompact!(0, { type: "schedule" });
    await s.submitText("first compact");
    const old = view(s).recap;
    const file = join(root, ".herta", "compaction", `${s.sessionId}.json`),
      bytes = readFileSync(file);
    script.failWrite = true;
    script.requests = [];
    s.updateCompact!(view(s).revision, { type: "schedule" });
    await s.submitText("second compact");
    expect(view(s)).toMatchObject({
      status: "failed",
      reason: "storage",
      recap: old,
    });
    expect(readFileSync(file)).toEqual(bytes);
    expect(JSON.stringify(script.requests.at(-1)!.messages)).toContain(
      "QUESTION-0-131",
    );
  });
  it("keeps the compacted context through structured input continuation and does not accept a new queue during the question", async () => {
    const { root, host } = fixture();
    const s = await host.createSession({ backendWorkspace: root });
    await seed(s);
    script.ask = true;
    s.updateCompact!(0, { type: "schedule" });
    await s.submitText("clarify after compacting");
    expect(view(s).status).toBe("completed");
    expect(s.updateCompact!(view(s).revision, { type: "schedule" })).toEqual({
      ok: false,
      reason: "busy",
    });
    const pending = s.getPendingUserInput!();
    if (!pending) throw new Error("missing question");
    script.requests = [];
    await s.answerUserInput!({
      schemaVersion: 1,
      sessionId: s.sessionId,
      requestId: pending.requestId,
      turnId: pending.turnId,
      action: "answer",
      answers: [
        { questionId: "q", optionIds: [], text: "Use the first option" },
      ],
    });
    await vi.waitFor(() => expect(s.turnInFlight).toBe(false));
    expect(script.requests).toHaveLength(1);
    expect(JSON.stringify(script.requests[0]!.messages)).toContain(
      "SUMMARY-131",
    );
    expect(JSON.stringify(script.requests[0]!.messages)).not.toContain(
      "QUESTION-0-131",
    );
  });
  it("rejects queue changes while the summary is running; cancellation does not save a late summary", async () => {
    const { root, host } = fixture();
    const s = await host.createSession({ backendWorkspace: root });
    await seed(s);
    let release!: () => void;
    script.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.updateCompact!(0, { type: "schedule" });
    const run = s.submitText("interrupted compact");
    const settled = run.catch(() => undefined);
    await vi.waitFor(() => expect(view(s).status).toBe("running"));
    expect(
      s.updateCompact!(view(s).revision, { type: "cancel" }),
    ).toMatchObject({ ok: false, reason: "busy" });
    const interrupted = s.interrupt();
    release();
    await interrupted;
    await settled;
    expect(view(s)).toMatchObject({
      status: "failed",
      reason: "cancelled",
      recap: null,
    });
  });
  it("keeps current picture bytes in the context tail with original record indices and never sends pictures to the summary request", async () => {
    const { root, host } = fixture();
    const s = await host.createSession({ backendWorkspace: root });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
      "base64",
    );
    const first = await s.stageImages!([{ bytes: png, name: "older.png" }]);
    if (!first.ok) throw new Error("stage failed");
    await s.submitText("OLD-IMAGE-QUESTION", {
      stagedImageIds: [first.staged[0]!.id],
    });
    for (let n = 0; n < 5; n++) await s.submitText(`tail question ${n}`);
    const next = await s.stageImages!([{ bytes: png, name: "current.png" }]);
    if (!next.ok) throw new Error("stage failed");
    script.requests = [];
    s.updateCompact!(0, { type: "schedule" });
    await s.submitText("CURRENT-IMAGE-QUESTION", {
      stagedImageIds: [next.staged[0]!.id],
    });
    expect(view(s).status).toBe("completed");
    const summary = script.requests.find(
      (request) => request.tools.length === 0,
    )!;
    expect(
      summary.messages.flatMap((m) =>
        m.role === "user" ? (m.images ?? []) : [],
      ),
    ).toEqual([]);
    const persona = script.requests.at(-1)!;
    expect(
      persona.messages.flatMap((m) =>
        m.role === "user" ? (m.images ?? []) : [],
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(persona.messages)).not.toContain(
      "OLD-IMAGE-QUESTION",
    );
    expect(JSON.stringify(persona.messages)).toContain(
      "CURRENT-IMAGE-QUESTION",
    );
    expect(existsSync(join(root, first.staged[0]!.path))).toBe(true);
    expect(existsSync(join(root, next.staged[0]!.path))).toBe(true);
    const summaries = await s.getRoundSummaries!();
    const pictures = summaries.at(-1)!.pictures;
    expect(pictures?.persona).toEqual([
      {
        path: next.staged[0]!.path,
        index: s.record.findIndex(
          (b) =>
            b.kind === "system" &&
            b.digest?.kind === "attachment" &&
            b.digest.path === next.staged[0]!.path,
        ),
        outcome: "sent",
      },
    ]);
  });
  it("keeps the cache on failed transcript deletion and removes it on successful deletion", async () => {
    const { root, host } = fixture();
    const s = await host.createSession({ backendWorkspace: root });
    await seed(s);
    s.updateCompact!(0, { type: "schedule" });
    await s.submitText("compact");
    const file = join(root, ".herta", "compaction", `${s.sessionId}.json`),
      bytes = readFileSync(file);
    script.failDelete = true;
    expect(await host.deleteSession(s.sessionId)).toMatchObject({
      ok: false,
      removed: false,
    });
    expect(readFileSync(file)).toEqual(bytes);
    script.failDelete = false;
    await host.openSession({ sessionId: s.sessionId });
    expect((await host.deleteSession(s.sessionId)).ok).toBe(true);
    expect(existsSync(file)).toBe(false);
  });
  it("does not revive a discarded summary after rewinding across its boundary and growing a different conversation", async () => {
    const { root, host } = fixture();
    const s = await host.createSession({ backendWorkspace: root });
    await seed(s);
    s.updateCompact!(0, { type: "schedule" });
    await s.submitText("compact");
    const boundary = view(s).recap!.boundaryIndex;
    while (s.record.length > boundary)
      expect((await s.rewindLastTurn!()).ok).toBe(true);
    expect(view(s).recap).toBeNull();
    const file = join(root, ".herta", "compaction", `${s.sessionId}.json`);
    expect(existsSync(file)).toBe(false);
    script.requests = [];
    for (let n = 0; n < 6; n++) await s.submitText(`replacement ${n}`);
    expect(
      script.requests.every(
        (request) => !JSON.stringify(request.messages).includes("SUMMARY-131"),
      ),
    ).toBe(true);
    await host.closeActiveSession();
    const reopened = await host.openSession({ sessionId: s.sessionId });
    expect(view(reopened).recap).toBeNull();
  });
});
