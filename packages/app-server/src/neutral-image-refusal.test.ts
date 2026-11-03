import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRequest, ProviderConfig } from "@herta/providers";
import type { ImageRequestRefused } from "@herta/providers/images";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { turnErrorPayload } from "./session.js";
import { createSessionHost } from "./session-host.js";
import { removeTmpDir } from "./testing/tmp-workspace.js";
import type { AppServerConfig, SessionHost } from "./types.js";

// R110 (F06): a service refusing a workbench request that carried pictures. Deterministic adapters
// on a real host and record; not a service or packaged-app verification.
type Outcome =
  | {
      readonly kind: "reply" | "delegate" | "ask" | "stall" | "network" | "sse";
    }
  | { readonly kind: "http"; readonly status: number };
const script = vi.hoisted(() => ({
  seen: [] as { modelId: string; images: number; answered: boolean }[],
  /** Taken one per request, in order; a plain reply once empty. */
  persona: [] as Outcome[],
  executor: [] as Outcome[],
}));
vi.mock("@herta/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@herta/providers")>();
  const fail = (code: "stall" | "network" | "sse") =>
    new actual.ProviderError({
      code,
      message: `synthetic ${code}`,
      retryable: false,
    });
  return {
    ...actual,
    createProtocolAdapter: (config: ProviderConfig) => ({
      protocol: config.protocol,
      async *stream(request: ModelRequest) {
        const nativeContext = {
          providerId: config.id,
          providerRevision: config.revision,
          protocol: config.protocol,
          modelId: request.modelId,
          opaque: { private: "r110" },
        };
        const persona = request.modelId === "persona-model";
        const answered = request.messages.some((m) => m.role === "tool");
        script.seen.push({
          modelId: request.modelId,
          answered,
          images: request.messages.reduce(
            (n, m) => n + (m.role === "user" ? (m.images?.length ?? 0) : 0),
            0,
          ),
        });
        const outcome = (persona
          ? script.persona
          : script.executor
        ).shift() ?? {
          kind: "reply",
        };
        if (outcome.kind === "http")
          throw new actual.ProviderError({
            code: "http",
            status: outcome.status,
            // httpDiagnostic's shape: remote code/param ride along, and must not decide anything.
            message: `Provider HTTP ${outcome.status} (code=invalid_request_error; param=messages[1].content[1])`,
            retryable: false,
          });
        if (outcome.kind === "stall" || outcome.kind === "network")
          throw fail(outcome.kind);
        if (outcome.kind === "sse") {
          yield { type: "text-delta", text: "partial" };
          throw fail("sse");
        }
        if (outcome.kind === "delegate" || outcome.kind === "ask") {
          yield {
            type: "tool-call-ready",
            call:
              outcome.kind === "delegate"
                ? { id: "delegate-1", tool: "delegate_execution", input: {} }
                : {
                    id: "input-1",
                    tool: "request_user_input",
                    input: {
                      questions: [
                        {
                          id: "q",
                          prompt: "哪一处？",
                          kind: "text",
                          required: true,
                          allowText: true,
                          options: [],
                        },
                      ],
                    },
                  },
          };
          yield { type: "finished", reason: "tool-calls", nativeContext };
          return;
        }
        yield {
          type: "text-delta",
          text: persona ? "Seen." : "Execution finished.",
        };
        yield { type: "finished", reason: "stop", nativeContext };
      },
    }),
  };
});

/** A 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);
const roots: string[] = [];
const hosts: SessionHost[] = [];
beforeEach(() => {
  script.seen = [];
  script.persona = [];
  script.executor = [];
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.closeActiveSession();
  for (const root of roots.splice(0)) await removeTmpDir(root);
});

function provider(id: string, revision = 1): ProviderConfig {
  return {
    id,
    name: id,
    protocol: "openai-chat-completions",
    baseURL: "https://example.invalid/v1",
    authentication: "none",
    credentialRef: null,
    allowRemoteHTTP: false,
    revision,
    models: [
      {
        id: `${id}-model`,
        source: "manual",
        capabilities: {
          streaming: "supported",
          tools: "supported",
          images: id === "persona" ? "supported" : "unknown",
          reasoning: "unknown",
        },
        validation: {
          state: "tools-available",
          protocol: "openai-chat-completions",
          providerRevision: revision,
        },
      },
    ],
    defaults: { model: `${id}-model`, timeoutMs: 1000 },
  };
}
function fixture(refused = vi.fn<(r: ImageRequestRefused) => void>()) {
  const root = mkdtempSync(join(tmpdir(), "herta-r110-refusal-"));
  roots.push(root);
  const persona = provider("persona", 3);
  const executor = provider("executor");
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
          persona,
          executor,
          bindings: {
            persona: { providerId: persona.id, modelId: "persona-model" },
            executor: { providerId: executor.id, modelId: "executor-model" },
          },
        },
        personaKey: null,
        executorKey: null,
      }),
      onImageRequestRefused: refused,
    },
  };
  const host = createSessionHost(config);
  hosts.push(host);
  return { root, host, refused };
}
function picked(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "herta-r110-picked-"));
  roots.push(dir);
  const path = join(dir, name);
  writeFileSync(path, PNG);
  return path;
}
const personaRequests = () =>
  script.seen.filter((s) => s.modelId === "persona-model");
const marked = (status: number): ImageRequestRefused => ({
  providerId: "persona",
  providerRevision: 3,
  modelId: "persona-model",
  status,
  surface: "workbench",
});
async function failure(
  turn: Promise<unknown>,
): Promise<Record<string, unknown>> {
  try {
    await turn;
  } catch (error) {
    return error as Record<string, unknown>;
  }
  throw new Error("the turn did not fail");
}

describe("a refused workbench request that carried pictures (R110)", () => {
  it.each([
    400, 415, 422,
  ])("HTTP %i: fails with image-rejected and the status, marks the persona model once, sends nothing again", async (status) => {
    const { root, host, refused } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    expect((await session.attachFiles!([picked("screen.png")])).ok).toBe(true);
    script.persona = [{ kind: "http", status }];
    const error = await failure(session.submitText("看到了什么？"));
    expect(error).toMatchObject({ code: "image-rejected", status });
    // What the GUI receives: the new code as providerCode, the HTTP status kept.
    expect(turnErrorPayload(error)).toMatchObject({
      code: "ProviderError",
      providerCode: "image-rejected",
      status,
    });
    expect(refused.mock.calls).toEqual([[marked(status)]]);
    expect(personaRequests()).toEqual([
      { modelId: "persona-model", answered: false, images: 1 },
    ]);
  });

  it("HTTP 413 says the request was too large and marks nothing", async () => {
    const { root, host, refused } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png")]);
    script.persona = [{ kind: "http", status: 413 }];
    const error = await failure(session.submitText("看到了什么？"));
    expect(error).toMatchObject({ code: "image-too-large", status: 413 });
    expect(refused).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "http", status: 401 },
    { kind: "http", status: 403 },
    { kind: "http", status: 404 },
    { kind: "http", status: 429 },
    { kind: "http", status: 500 },
    { kind: "http", status: 503 },
    { kind: "stall" },
    { kind: "network" },
    { kind: "sse" },
  ] as const)("%j with a picture keeps its own failure and marks nothing", async (outcome) => {
    const { root, host, refused } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png")]);
    script.persona = [outcome];
    const error = await failure(session.submitText("看到了什么？"));
    expect(error).toMatchObject(
      outcome.kind === "http"
        ? { code: "http", status: outcome.status }
        : { code: outcome.kind },
    );
    expect(refused).not.toHaveBeenCalled();
  });

  it("HTTP 400 on a request without pictures keeps its own failure and marks nothing", async () => {
    const { root, host, refused } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    script.persona = [{ kind: "http", status: 400 }];
    const error = await failure(session.submitText("你好"));
    expect(error).toMatchObject({ code: "http", status: 400 });
    expect(refused).not.toHaveBeenCalled();
    expect(personaRequests()[0]?.images).toBe(0);
  });

  it("counts earlier pictures the request shows again, as they were sent", async () => {
    const { root, host, refused } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png")]);
    await session.submitText("看到了什么？");
    script.persona = [{ kind: "http", status: 400 }];
    const error = await failure(session.submitText("左上角写了什么？"));
    expect(error).toMatchObject({ code: "image-rejected", status: 400 });
    expect(personaRequests().map((r) => r.images)).toEqual([1, 1]);
    expect(refused.mock.calls).toEqual([[marked(400)]]);
  });

  it("marks a refusal of the answer to a waiting question, whose picture comes from the journal", async () => {
    const { root, host, refused } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png")]);
    script.persona = [{ kind: "ask" }, { kind: "http", status: 422 }];
    await session.submitText("看到了什么？");
    const pending = session.getPendingUserInput?.();
    expect(pending).not.toBeNull();
    expect(refused).not.toHaveBeenCalled();
    await session.answerUserInput?.({
      schemaVersion: 1,
      requestId: pending!.requestId,
      sessionId: pending!.sessionId,
      turnId: pending!.turnId,
      action: "answer",
      answers: [{ questionId: "q", optionIds: [], text: "左上角" }],
    });
    // The answer resumes the turn in the background (neutral-pictures.test.ts).
    const deadline = Date.now() + 10000;
    while (session.turnInFlight || !refused.mock.calls.length) {
      if (Date.now() > deadline) throw new Error("answer turn did not run");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(personaRequests().find((r) => r.answered)?.images).toBe(1);
    expect(refused.mock.calls).toEqual([[marked(422)]]);
  });

  it("never marks the persona model for the executor's refusal: its requests carry no pictures", async () => {
    const { root, host, refused } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.setWorkspaceTrust?.("workspace");
    await session.attachFiles!([picked("screen.png")]);
    script.persona = [{ kind: "delegate" }];
    script.executor = [{ kind: "http", status: 400 }];
    const outcome = await session.submitText("看图后修改文件").then(
      () => null,
      (error: Record<string, unknown>) => error,
    );
    const executor = script.seen.filter((s) => s.modelId === "executor-model");
    expect(executor.length).toBeGreaterThan(0);
    expect(executor.every((r) => r.images === 0)).toBe(true);
    expect(refused).not.toHaveBeenCalled();
    if (outcome) expect(outcome.code).not.toBe("image-rejected");
  });

  it("a mark that cannot be written leaves the turn's failure as it is", async () => {
    const { root, host, refused } = fixture(
      vi.fn(() => {
        throw new Error("disk unavailable");
      }),
    );
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png")]);
    script.persona = [{ kind: "http", status: 400 }];
    const error = await failure(session.submitText("看到了什么？"));
    expect(error).toMatchObject({ code: "image-rejected", status: 400 });
    expect(refused).toHaveBeenCalledOnce();
    // Not sent again on its own: the next send is the user's.
    expect(personaRequests()).toHaveLength(1);
  });
});
