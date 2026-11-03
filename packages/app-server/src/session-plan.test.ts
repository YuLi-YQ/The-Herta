import {
  existsSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  mode: "reply",
  requests: [] as ModelRequest[],
  mutate: null as (() => void) | null,
}));
vi.mock("@herta/core", async (original) => {
  const actual = await original<typeof import("@herta/core")>();
  return {
    ...actual,
    writeFileAtomicSync: (
      ...args: Parameters<typeof actual.writeFileAtomicSync>
    ) => {
      if (script.failWrite && String(args[0]).includes("plans"))
        throw new Error("synthetic plan storage failure");
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
        if (script.hold) await script.hold;
        request.signal.throwIfAborted();
        if (script.mode === "fail") {
          yield {
            type: "text-delta",
            text: "Partial unfinished reply",
          } as const;
          throw new Error("Synthetic response failure");
        }
        if (script.mode === "empty") {
          yield { type: "finished", reason: "stop" } as const;
          return;
        }
        const call = (id: string, tool: string, input: unknown) =>
          ({ type: "tool-call-ready", call: { id, tool, input } }) as const;
        const isExecutor = request.tools.some(
          (tool) => tool.name === "write_new_file",
        );
        const delegates = request.tools.some(
          (tool) => tool.name === "delegate_execution",
        );
        if (
          script.mode === "input" &&
          !request.messages.some(
            (m) => m.role === "tool" && m.toolCallId === "ask",
          )
        ) {
          yield { type: "text-delta", text: "Which option?" } as const;
          yield call("ask", "request_user_input", {
            questions: [
              {
                id: "q",
                prompt: "Choose",
                kind: "text",
                required: true,
                allowText: true,
                options: [],
              },
            ],
          });
          yield { type: "finished", reason: "tool-calls" } as const;
          return;
        }
        if (script.mode === "tools" && delegates) {
          yield call("delegate", "delegate_execution", {});
          yield { type: "finished", reason: "tool-calls" } as const;
          return;
        }
        if (
          script.mode === "tools" &&
          isExecutor &&
          !request.messages.some((m) => m.role === "tool")
        ) {
          script.mutate?.();
          yield call("write", "write_new_file", {
            path: "forbidden.txt",
            content: "must not exist",
          });
          yield call("command", "run_command", {
            argv: [
              process.execPath,
              "-e",
              "require('node:fs').writeFileSync('forbidden-command.txt','bad')",
            ],
          });
          yield call("read", "read_file", { path: "readable.txt" });
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
  script.mode = "reply";
  script.requests = [];
  script.mutate = null;
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.closeActiveSession();
  for (const root of roots.splice(0)) await removeTmpDir(root);
});
function fixture(overrides: Partial<AppServerConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), "herta-plan-session-"));
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
          images: "unknown",
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
  const host = createSessionHost({
    ...config,
    getPermissionMode: () => ({ mode: "workspace-edit", revision: 1 }),
    ...overrides,
  });
  hosts.push(host);
  return { root, host };
}

describe("workbench plans on a real Session", () => {
  it("retains user revisions, injects them on the next turn, captures the successful final response and survives reopen", async () => {
    const { root, host } = fixture();
    const s = await host.createSession({ backendWorkspace: root });
    expect(s.updatePlan!(0, { type: "enter" })).toMatchObject({
      ok: true,
      view: { locked: true, state: { previousMode: "workspace-edit" } },
    });
    expect(
      s.updatePlan!(1, { type: "save", text: "User's checked PLAN-130" }).ok,
    ).toBe(true);
    await s.submitText("propose a plan");
    expect(script.systems[0]).toContain("PLAN-130");
    expect(script.systems[0]).toContain("计划模式");
    expect(s.getPlan!()).toMatchObject({
      view: {
        locked: true,
        state: {
          revision: 3,
          plan: { text: "Synthetic reply.", source: "model" },
          history: [{ source: "user", text: "User's checked PLAN-130" }],
        },
      },
    });
    await host.closeActiveSession();
    expect(s.getPlan!()).toMatchObject({ ok: false, reason: "no_target" });
    const reopened = await host.openSession({ sessionId: s.sessionId });
    expect(reopened.getPlan!()).toMatchObject({
      view: { locked: true, state: { revision: 3 } },
    });
    expect(reopened.updatePlan!(3, { type: "exit" })).toMatchObject({
      ok: true,
      restoredMode: "workspace-edit",
      view: { locked: false },
    });
    await reopened.submitText("normal reply");
    expect(script.systems.at(-1)).not.toContain("计划模式");
    expect(reopened.getPlan!()).toMatchObject({
      view: { state: { revision: 4, plan: { text: "Synthetic reply." } } },
    });
  });
  it("keeps successful output when autosave fails and reports the separate save error", async () => {
    const { root, host } = fixture();
    const s = await host.createSession({ backendWorkspace: root });
    s.updatePlan!(0, { type: "enter" });
    s.updatePlan!(1, { type: "save", text: "Kept" });
    script.failWrite = true;
    await expect(s.submitText("new plan")).resolves.toMatchObject({
      turnId: expect.any(String),
    });
    expect(
      s.record.some((b) => b.kind === "herta" && b.text === "Synthetic reply."),
    ).toBe(true);
    expect(s.getPlan!()).toMatchObject({
      view: {
        saveError: "storage",
        locked: true,
        state: { revision: 2, plan: { text: "Kept" } },
      },
    });
    script.failWrite = false;
    script.mode = "fail";
    await expect(s.submitText("failed turn")).rejects.toThrow();
    expect(s.getPlan!()).toMatchObject({
      view: { state: { revision: 2, plan: { text: "Kept" } } },
    });
  });
  it("does not save an intermediate request for human input, then saves the final answer", async () => {
    const { root, host } = fixture();
    const s = await host.createSession({ backendWorkspace: root });
    s.updatePlan!(0, { type: "enter" });
    s.updatePlan!(1, { type: "save", text: "Prior reviewed plan" });
    script.mode = "input";
    await s.submitText("ask me first");
    expect(s.getPlan!()).toMatchObject({
      view: { state: { revision: 2, plan: { text: "Prior reviewed plan" } } },
    });
    const pending = s.getPendingUserInput!();
    if (!pending) throw new Error("missing question");
    await s.answerUserInput!({
      schemaVersion: 1,
      requestId: pending.requestId,
      sessionId: s.sessionId,
      turnId: pending.turnId,
      action: "answer",
      answers: [
        { questionId: "q", optionIds: [], text: "Proceed with analysis" },
      ],
    });
    await vi.waitFor(() => expect(s.turnInFlight).toBe(false));
    expect(s.getPlan!()).toMatchObject({
      view: {
        state: {
          revision: 3,
          plan: { text: "Synthetic reply.", source: "model" },
        },
      },
    });
  });
  it("does not recapture a historical speech when the current turn produces no final speech", async () => {
    const { root, host } = fixture();
    const s = await host.createSession({ backendWorkspace: root });
    await s.submitText("historical answer");
    s.updatePlan!(0, { type: "enter" });
    s.updatePlan!(1, { type: "save", text: "Keep the user's reviewed plan" });
    script.mode = "empty";
    await s.submitText("empty turn");
    expect(s.getPlan!()).toMatchObject({
      view: {
        state: {
          revision: 2,
          plan: { source: "user", text: "Keep the user's reviewed plan" },
        },
      },
    });
  });
  it.each([
    "active",
    "damaged",
    "raw-invalid",
  ])("denies write tools and commands, permits reading, and gives executor planning context (%s)", async (mode) => {
    const { root, host } = fixture(
      mode === "raw-invalid"
        ? { getPermissionMode: () => ({ mode: "full-access", revision: 0 }) }
        : { getPermissionMode: () => ({ mode: "full-access", revision: 8 }) },
    );
    const s = await host.createSession({ backendWorkspace: root });
    writeFileSync(join(root, "readable.txt"), "READ-ONLY-EVIDENCE-130");
    if (mode !== "raw-invalid") s.updatePlan!(0, { type: "enter" });
    const sidecar = join(root, ".herta", "plans", `${s.sessionId}.json`);
    if (mode === "damaged") writeFileSync(sidecar, "damaged");
    // Even removing the sidecar during a provider response cannot release this turn's lock.
    if (mode === "active") script.mutate = () => unlinkSync(sidecar);
    script.mode = "tools";
    await s.submitText("write requested files and read the source");
    expect(existsSync(join(root, "forbidden.txt"))).toBe(false);
    expect(existsSync(join(root, "forbidden-command.txt"))).toBe(false);
    const executor = script.requests.filter((r) =>
      r.tools.some((t) => t.name === "write_new_file"),
    );
    expect(executor.length).toBeGreaterThan(1);
    if (mode !== "raw-invalid")
      expect(executor[0]!.system).toContain("计划模式");
    const results = executor.flatMap((r) =>
      r.messages.filter((m) => m.role === "tool"),
    );
    expect(JSON.stringify(results)).toContain("READ-ONLY-EVIDENCE-130");
    expect(JSON.stringify(results)).toContain("permission_read_only");
    if (mode === "active")
      expect(s.getPlan!()).toMatchObject({ view: { saveError: "conflict" } });
  });
  it("keeps the mode locked during restore, requires full confirmation, and retains it on restore or persistence failure", async () => {
    let s: Awaited<ReturnType<SessionHost["createSession"]>>;
    let fault = "confirm";
    const { root, host } = fixture({
      getPermissionMode: () => ({ mode: "full-access", revision: 1 }),
      restorePermissionMode: (_sid, _root, _previous, confirm) => {
        expect(s.getPlan!()).toMatchObject({ view: { locked: true } });
        if (fault === "confirm" && !confirm)
          throw Object.assign(new Error("confirm"), {
            code: "confirmation_required",
          });
        if (fault === "restore") throw new Error("restore failed");
        return fault === "lowered" ? "read-only" : "full-access";
      },
    });
    s = await host.createSession({ backendWorkspace: root });
    s.updatePlan!(0, { type: "enter" });
    expect(s.updatePlan!(1, { type: "exit" })).toMatchObject({
      ok: false,
      reason: "confirmation_required",
    });
    fault = "restore";
    expect(
      s.updatePlan!(1, { type: "exit", confirmFullAccess: true }),
    ).toMatchObject({ ok: false, reason: "storage", view: { locked: true } });
    fault = "confirm";
    script.failWrite = true;
    expect(
      s.updatePlan!(1, { type: "exit", confirmFullAccess: true }),
    ).toMatchObject({ ok: false, reason: "storage", view: { locked: true } });
    script.failWrite = false;
    fault = "lowered";
    expect(s.updatePlan!(1, { type: "exit" })).toMatchObject({
      ok: true,
      restoredMode: "read-only",
      view: { locked: false },
    });
  });
  it("refuses changes while running and rejects a stale autosave without overwriting a newer revision", async () => {
    const { root, host } = fixture();
    const s = await host.createSession({ backendWorkspace: root });
    s.updatePlan!(0, { type: "enter" });
    let release!: () => void;
    script.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = s.submitText("wait");
    try {
      await vi.waitFor(() => expect(script.requests).toHaveLength(1));
      expect(s.updatePlan!(1, { type: "exit" })).toMatchObject({
        ok: false,
        reason: "busy",
      });
      const path = join(root, ".herta", "plans", `${s.sessionId}.json`);
      const data = JSON.parse(readFileSync(path, "utf8"));
      data.state.revision = 2;
      writeFileSync(path, JSON.stringify(data));
    } finally {
      release();
      await run;
    }
    expect(s.getPlan!()).toMatchObject({
      view: { saveError: "conflict", state: { revision: 2, plan: null } },
    });
  });
  it("does not expose plan mutations without a permission host, and does not restore a changed raw grant without a callback", async () => {
    const absent = fixture({ getPermissionMode: undefined });
    const a = await absent.host.createSession({
      backendWorkspace: absent.root,
    });
    expect(a.updatePlan!(0, { type: "enter" })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    let raw: "workspace-edit" | "read-only" = "workspace-edit";
    const present = fixture({
      getPermissionMode: () => ({ mode: raw, revision: 1 }),
    });
    const b = await present.host.createSession({
      backendWorkspace: present.root,
    });
    b.updatePlan!(0, { type: "enter" });
    raw = "read-only";
    expect(b.updatePlan!(1, { type: "exit" })).toMatchObject({
      ok: false,
      reason: "unavailable",
      view: { locked: true },
    });
  });
  it("retains the sidecar after failed transcript deletion and removes it after successful deletion", async () => {
    const { root, host } = fixture();
    const s = await host.createSession({ backendWorkspace: root });
    s.updatePlan!(0, { type: "enter" });
    const file = join(root, ".herta", "plans", `${s.sessionId}.json`);
    const before = readFileSync(file);
    script.failDelete = true;
    expect(await host.deleteSession(s.sessionId)).toMatchObject({
      ok: false,
      removed: false,
    });
    expect(readFileSync(file)).toEqual(before);
    script.failDelete = false;
    await host.openSession({ sessionId: s.sessionId });
    expect((await host.deleteSession(s.sessionId)).ok).toBe(true);
    expect(existsSync(file)).toBe(false);
  });
});
