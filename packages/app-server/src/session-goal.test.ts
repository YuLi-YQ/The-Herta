import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
}));
vi.mock("@herta/core", async (original) => {
  const actual = await original<typeof import("@herta/core")>();
  return {
    ...actual,
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
        if (script.hold) await script.hold;
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
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.closeActiveSession();
  for (const root of roots.splice(0)) await removeTmpDir(root);
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "herta-goal-session-"));
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
  const host = createSessionHost(config);
  hosts.push(host);
  return { root, host };
}

describe("task goals on a real Session host (F09)", () => {
  it("persists per task, follows the record anchor on workspace changes, and only active goals enter future requests", async () => {
    const { root, host } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    expect(session.getGoal!()).toMatchObject({
      ok: true,
      view: { state: { active: null } },
    });
    await session.submitText("before goal");
    const base = script.systems.at(-1)!;
    expect(
      session.updateGoal!(0, { type: "set", text: "GOAL-FIRST-129" }).ok,
    ).toBe(true);
    await session.submitText("goal turn");
    expect(script.systems.at(-1)!.startsWith(base)).toBe(true);
    expect(script.systems.at(-1)).toContain("GOAL-FIRST-129");
    const moved = join(root, "different-project");
    mkdirSync(moved);
    expect((await session.setWorkspace(moved)).ok).toBe(true);
    expect(
      session.updateGoal!(1, { type: "set", text: "GOAL-UPDATED-129" }).ok,
    ).toBe(true);
    const sidecar = join(root, ".herta", "goals", `${session.sessionId}.json`);
    expect(existsSync(sidecar)).toBe(true);
    expect(existsSync(join(moved, ".herta", "goals"))).toBe(false);
    await host.closeActiveSession();
    expect(
      session.updateGoal!(2, { type: "end", status: "done" }),
    ).toMatchObject({ ok: false, reason: "no_target" });
    const reopened = await host.openSession({ sessionId: session.sessionId });
    expect(reopened.getGoal!()).toMatchObject({
      view: { state: { revision: 2, active: { text: "GOAL-UPDATED-129" } } },
    });
    await reopened.submitText("after reopen");
    expect(script.systems.at(-1)).toContain("GOAL-UPDATED-129");
    expect(script.systems.at(-1)).not.toContain("GOAL-FIRST-129");
    expect(
      reopened.updateGoal!(2, {
        type: "end",
        status: "done",
        result: "Owner checked it",
      }).ok,
    ).toBe(true);
    await reopened.submitText("after completion");
    expect(script.systems.at(-1)).toBe(base);
    expect(reopened.getGoal!()).toMatchObject({
      view: {
        state: {
          active: null,
          history: [{ status: "done", result: "Owner checked it" }],
        },
      },
    });
  });

  it("isolates targets and removes only the selected task's current goal on deletion", async () => {
    const { root, host } = fixture();
    const first = await host.createSession({ backendWorkspace: root });
    first.updateGoal!(0, { type: "set", text: "First" });
    const second = await host.createSession({ backendWorkspace: root });
    expect(second.getGoal!()).toMatchObject({
      view: { state: { active: null } },
    });
    second.updateGoal!(0, { type: "set", text: "Second" });
    expect((await host.deleteSession(first.sessionId)).ok).toBe(true);
    expect(
      existsSync(join(root, ".herta", "goals", `${first.sessionId}.json`)),
    ).toBe(false);
    expect(second.getGoal!()).toMatchObject({
      view: { state: { active: { text: "Second" } } },
    });
  });

  it("does not silently drop a damaged goal or send it to a model; explicit reset preserves its bytes", async () => {
    const { root, host } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    session.updateGoal!(0, { type: "set", text: "Before damage" });
    const file = join(root, ".herta", "goals", `${session.sessionId}.json`);
    writeFileSync(file, "synthetic damaged goal");
    expect(session.getGoal!()).toMatchObject({
      ok: true,
      view: { damaged: true },
    });
    await expect(session.submitText("blocked")).rejects.toMatchObject({
      code: "goal-damaged",
    });
    expect(script.systems).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("synthetic damaged goal");
    expect(session.updateGoal!(0, { type: "reset" }).ok).toBe(true);
    await session.submitText("after explicit recovery");
    expect(script.systems).toHaveLength(1);
  });

  it("keeps the goal when the task transcript could not be deleted", async () => {
    const { root, host } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    session.updateGoal!(0, {
      type: "set",
      text: "Goal must survive failed deletion",
    });
    const file = join(root, ".herta", "goals", `${session.sessionId}.json`);
    const before = readFileSync(file);
    script.failDelete = true;
    expect(await host.deleteSession(session.sessionId)).toMatchObject({
      ok: false,
      removed: false,
    });
    expect(readFileSync(file)).toEqual(before);
    script.failDelete = false;
    const reopened = await host.openSession({ sessionId: session.sessionId });
    expect(reopened.getGoal!()).toMatchObject({
      view: {
        state: { active: { text: "Goal must survive failed deletion" } },
      },
    });
  });

  it("refuses a damaged goal before consuming pending pictures or recording the message", async () => {
    const { root, host } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
      "base64",
    );
    const staged = await session.stageImages!([
      { bytes: png, name: "pending.png" },
    ]);
    if (!staged.ok) throw new Error("stage failed");
    session.updateGoal!(0, { type: "set", text: "Before damage" });
    writeFileSync(
      join(root, ".herta", "goals", `${session.sessionId}.json`),
      "damaged",
    );
    const before = session.record;
    await expect(
      session.submitText("retain my picture", {
        stagedImageIds: [staged.staged[0]!.id],
      }),
    ).rejects.toMatchObject({ code: "goal-damaged" });
    expect(session.stagedImageList).toEqual(staged.staged);
    expect(session.record).toEqual(before);
    expect(existsSync(join(root, staged.staged[0]!.path))).toBe(true);
    expect(script.systems).toEqual([]);
  });

  it("refuses updates during a turn so all requests use the turn-start target", async () => {
    const { root, host } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    session.updateGoal!(0, { type: "set", text: "Captured goal" });
    let release!: () => void;
    script.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = session.submitText("hold");
    try {
      await vi.waitFor(() => expect(script.systems).toHaveLength(1));
      expect(
        session.updateGoal!(1, { type: "set", text: "Too late" }),
      ).toMatchObject({ ok: false, reason: "busy" });
      expect(script.systems[0]).toContain("Captured goal");
    } finally {
      release();
      await running;
    }
    expect(session.getGoal!()).toMatchObject({
      view: { state: { revision: 1, active: { text: "Captured goal" } } },
    });
  });
});
