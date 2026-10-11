import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppServerConfig, createSessionHost } from "@herta/app-server";
import type { ModelRequest, ProviderConfig } from "@herta/providers";
import { expect, it, vi } from "vitest";
import {
  prepareSessionNavigation,
  startForwarders,
} from "./session-service.js";

vi.mock("@herta/providers", async (load) => ({
  ...(await load<typeof import("@herta/providers")>()),
  createProtocolAdapter: () => ({
    async *stream(request: ModelRequest) {
      yield { type: "text-delta", text: "deterministic partial before switch" };
      await new Promise<void>((_resolve, reject) =>
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true },
        ),
      );
    },
  }),
}));

it("requires current-session confirmation and blocks approvals and stale confirmations", async () => {
  const current = {
    sessionId: "A",
    overlay: null as unknown,
    turnInFlight: true,
    interrupt: vi.fn(async () => {
      current.turnInFlight = false;
    }),
  };
  expect(await prepareSessionNavigation(() => current)).toBe(false);
  expect(
    await prepareSessionNavigation(() => current, {
      interruptActiveSessionId: "B",
    }),
  ).toBe(false);
  current.overlay = { requestId: "pending" };
  expect(
    await prepareSessionNavigation(() => current, {
      interruptActiveSessionId: "A",
    }),
  ).toBe(false);
  expect(current.interrupt).not.toHaveBeenCalled();
  current.overlay = null;
  expect(
    await prepareSessionNavigation(() => current, {
      interruptActiveSessionId: "A",
    }),
  ).toBe(true);
  expect(current.interrupt).toHaveBeenCalledTimes(1);
});

it("refuses to navigate when the active session changes while interruption settles", async () => {
  const first = {
    sessionId: "A",
    overlay: null,
    turnInFlight: true,
    interrupt: vi.fn(async () => {
      active = second;
    }),
  };
  const second = { ...first, sessionId: "B", turnInFlight: false };
  let active = first;
  expect(
    await prepareSessionNavigation(() => active, {
      interruptActiveSessionId: "A",
    }),
  ).toBe(false);
});

it("switches a real SessionHost after explicit interruption, preserves partial history and isolates subsequent events", async () => {
  const root = mkdtempSync(join(tmpdir(), "herta-r4-navigation-"));
  const provider: ProviderConfig = {
    id: "fixture",
    name: "fixture",
    protocol: "openai-responses",
    baseURL: "https://example.invalid",
    authentication: "none",
    credentialRef: null,
    allowRemoteHTTP: false,
    revision: 1,
    models: [
      {
        id: "fixture-model",
        source: "manual",
        capabilities: {
          streaming: "supported",
          tools: "supported",
          images: "unknown",
          reasoning: "unknown",
        },
        validation: {
          state: "tools-available",
          protocol: "openai-responses",
          providerRevision: 1,
        },
      },
    ],
    defaults: { model: "fixture-model", timeoutMs: 1000 },
  };
  const config: AppServerConfig = {
    workspaceRoot: root,
    transcriptDir: join(root, "transcripts"),
    projectMemoryDir: join(root, "memory"),
    userMemoryDir: join(root, "user-memory"),
    narrativeDir: join(root, "narrative"),
    providers: {
      deepseekApiKey: "",
      actorModel: "unused",
      backendModel: "unused",
      routerModel: "unused",
    },
    neutralProviders: {
      resolveTurn: async (sessionId, turnId) => ({
        personaKey: null,
        executorKey: null,
        snapshot: {
          sessionId,
          turnId,
          persona: provider,
          executor: provider,
          bindings: {
            persona: { providerId: provider.id, modelId: "fixture-model" },
            executor: { providerId: provider.id, modelId: "fixture-model" },
          },
        },
      }),
    },
  };
  const host = createSessionHost(config);
  let stop = () => {};
  try {
    const first = await host.createSession({
      workspaceRoot: root,
      backendWorkspace: root,
    });
    const seen: unknown[] = [];
    stop = startForwarders(first, (_channel, event) => seen.push(event));
    const turn = first.submitText("fixture text").catch(() => undefined);
    await vi.waitFor(() => expect(first.turnInFlight).toBe(true));
    await vi.waitFor(() =>
      expect(JSON.stringify(seen)).toContain("partial before switch"),
    );
    expect(await prepareSessionNavigation(() => host.activeSession)).toBe(
      false,
    );
    expect(
      await prepareSessionNavigation(() => host.activeSession, {
        interruptActiveSessionId: first.sessionId,
      }),
    ).toBe(true);
    const second = await host.createSession({
      workspaceRoot: root,
      backendWorkspace: root,
    });
    stop();
    await turn;
    const oldCount = seen.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(oldCount);
    expect(
      readFileSync(
        join(config.transcriptDir, `${first.sessionId}.jsonl`),
        "utf8",
      ),
    ).toContain("partial before switch");
    expect(second.record).toHaveLength(0);
    await host.openSession({ sessionId: first.sessionId });
    expect(host.activeSession?.turnInFlight).toBe(false);
    expect(JSON.stringify(host.activeSession?.record)).toContain(
      "partial before switch",
    );
  } finally {
    stop();
    await host.closeActiveSession();
    host.dispose();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
