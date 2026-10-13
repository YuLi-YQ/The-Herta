import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ModelRequest,
  ProviderConfig,
  ProviderProtocol,
} from "@herta/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionHost } from "./session-host.js";
import { removeTmpDir } from "./testing/tmp-workspace.js";
import type { AppServerConfig, SessionHost } from "./types.js";

const script = vi.hoisted(() => ({
  requests: [] as { config: ProviderConfig; request: ModelRequest }[],
  mode: "delegate",
  releases: 0,
}));
vi.mock("@herta/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@herta/providers")>();
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
          opaque: { private: "private-reasoning-test-block" },
        };
        script.requests.push({ config, request });
        request.signal.throwIfAborted();
        if (
          (script.mode === "input" ||
            (script.mode === "input-after-write" &&
              (!request.tools.some(
                (tool) => tool.name === "delegate_execution",
              ) ||
                request.messages.some(
                  (message) =>
                    message.role === "tool" && message.toolCallId === "input-1",
                )))) &&
          request.modelId === "persona-model"
        ) {
          if (
            request.messages.some(
              (message) =>
                message.role === "tool" && message.toolCallId === "input-1",
            )
          ) {
            yield {
              type: "text-delta",
              text: "Received the explicit human answer.",
            };
            yield { type: "finished", reason: "stop", nativeContext };
          } else {
            yield {
              type: "tool-call-ready",
              call: {
                id: "input-1",
                tool: "request_user_input",
                input: {
                  questions: [
                    {
                      id: "q",
                      prompt: "选择方案",
                      kind: "single",
                      required: true,
                      allowText: true,
                      options: [{ id: "a", label: "A" }],
                    },
                  ],
                },
              },
            };
            yield { type: "finished", reason: "tool-calls", nativeContext };
          }
          return;
        }
        const persona = request.tools.some(
          (tool) => tool.name === "delegate_execution",
        );
        if (script.mode === "search-budget" && persona) {
          for (let i = 0; i < 3; i++) {
            yield { type: "web-search", id: `s${i}`, status: "searching" };
            yield { type: "web-search", id: `s${i}`, status: "searching", query: "query" };
          }
        }
        if (script.mode === "fail") {
          yield { type: "text-delta", text: "partial response" };
          throw new Error("Synthetic transport disconnected");
        }
        if (script.mode === "cancel") {
          await new Promise<void>((_resolve, reject) =>
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            ),
          );
          return;
        }
        if (
          script.mode === "interrupt-executor" &&
          request.modelId === "executor-model" &&
          request.messages.some((message) => message.role === "tool")
        ) {
          await new Promise<void>((_resolve, reject) =>
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            ),
          );
          return;
        }
        if (
          request.system.includes("For this planning response output only JSON")
        ) {
          const answered = request.messages.some(
            (m) => m.role === "user" && m.text.includes("[Structured result]"),
          );
          const executed = request.messages.some(
            (m) =>
              m.role === "user" && m.text.includes("Actual executor evidence"),
          );
          const questions = [
            {
              id: "q",
              prompt: "选择方案",
              kind: "single",
              required: true,
              allowText: true,
              options: [{ id: "a", label: "A" }],
            },
          ];
          yield {
            type: "text-delta",
            text: JSON.stringify({
              execute:
                script.mode === "text-only-invalid" ||
                (!executed && !answered && script.mode !== "text-only-input"),
              reply: "The text-only persona delegates the requested task.",
              ...(script.mode === "text-only-invalid" ||
              (script.mode === "text-only-input" && !answered) ||
              (script.mode === "text-only-after-write" && executed && !answered)
                ? { questions }
                : {}),
            }),
          };
          yield { type: "finished", reason: "stop", nativeContext };
        } else if (persona && script.mode !== "chat") {
          yield {
            type: "text-delta",
            text: "I will ask the executor to inspect the requested change.",
          };
          yield {
            type: "tool-call-ready",
            call: {
              id: "delegate-1",
              tool: "delegate_execution",
              input: script.mode === "malformed" ? { unexpected: true } : {},
            },
          };
          yield { type: "finished", reason: "tool-calls", nativeContext };
        } else if (
          request.tools.some((tool) => tool.name === "write_new_file") &&
          !request.messages.some((message) => message.role === "tool")
        ) {
          if (script.mode === "command") {
            yield {
              type: "tool-call-ready",
              call: {
                id: "command-1",
                tool: "run_command",
                input: {
                  argv: [
                    process.execPath,
                    "-e",
                    "process.stdout.write('R3 actual child command evidence')",
                  ],
                },
              },
            };
            yield { type: "finished", reason: "tool-calls", nativeContext };
            return;
          }
          yield {
            type: "tool-call-ready",
            call: {
              id: "write-1",
              tool: "write_new_file",
              input: {
                path: "中文（验证）.txt",
                content: "real isolated filesystem\n",
              },
            },
          };
          yield { type: "finished", reason: "tool-calls", nativeContext };
        } else {
          yield {
            type: "text-delta",
            text: request.tools.length
              ? "Execution finished."
              : "Conclusion based on recorded execution evidence.",
          };
          yield { type: "finished", reason: "stop", nativeContext };
        }
      },
    }),
  };
});

const roots: string[] = [];
const hosts: SessionHost[] = [];
beforeEach(() => {
  script.requests = [];
  script.mode = "delegate";
  script.releases = 0;
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.closeActiveSession();
  for (const root of roots.splice(0)) await removeTmpDir(root);
});
function provider(protocol: ProviderProtocol, id: string): ProviderConfig {
  return {
    id,
    name: id,
    protocol,
    baseURL: "https://example.invalid/prefix/v1",
    authentication: "none",
    credentialRef: null,
    allowRemoteHTTP: false,
    revision: 1,
    models: [
      {
        id: `${id}-model`,
        source: "manual",
        capabilities: {
          streaming: "supported",
          tools:
            script.mode.startsWith("text-only") && id === "persona"
              ? "unsupported"
              : "supported",
          images: "unknown",
          reasoning: "unknown",
        },
        validation: { state: "tools-available", protocol, providerRevision: 1 },
      },
    ],
    defaults: { model: "test-model", timeoutMs: 1000 },
  };
}
function fixture(
  personaProtocol: ProviderProtocol,
  executorProtocol = personaProtocol,
) {
  const root = mkdtempSync(join(tmpdir(), "herta-r3-neutral-黑塔（工作区）-"));
  roots.push(root);
  const persona = provider(personaProtocol, "persona");
  const executor = provider(executorProtocol, "executor");
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
        release: () => {
          script.releases++;
        },
      }),
    },
  };
  const host = createSessionHost(config);
  hosts.push(host);
  return { root, host, config, persona };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Timed out awaiting genuine session state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
describe("Neutral sessions — deterministic adapters, actual host/record/permission/tools", () => {
  it("shares search budget across persona passes without counting query updates twice", async () => {
    script.mode = "search-budget";
    const {root,host}=fixture("anthropic-messages");
    const session=await host.createSession({backendWorkspace:root});
    await session.setWorkspaceTrust?.("workspace");
    await session.submitText("Create test file");
    const requests=script.requests.filter(r=>r.request.modelId==="persona-model");
    expect(requests.map(r=>r.request.options.maxWebSearchUses)).toEqual([3,0]);
  });

  it("answer after reopening a question never replays a preceding completed file write", async () => {
    script.mode = "input-after-write";
    const { root, host } = fixture("openai-responses");
    const session = await host.createSession({ backendWorkspace: root });
    await session.setWorkspaceTrust?.("workspace");
    await session.submitText("Write a file, then ask me for the next decision");
    const file = join(root, "中文（验证）.txt");
    expect(existsSync(file)).toBe(true);
    const modified = statSync(file).mtimeMs;
    const executorRequests = script.requests.filter(
      (item) => item.request.modelId === "executor-model",
    ).length;
    const pending = session.getPendingUserInput?.();
    expect(pending).not.toBeNull();
    await host.closeActiveSession();
    const reopened = await host.openSession({ sessionId: session.sessionId });
    await reopened.answerUserInput?.({
      schemaVersion: 1,
      requestId: pending!.requestId,
      sessionId: pending!.sessionId,
      turnId: pending!.turnId,
      action: "answer",
      answers: [{ questionId: "q", optionIds: ["a"] }],
    });
    await until(() => !reopened.turnInFlight);
    expect(statSync(file).mtimeMs).toBe(modified);
    expect(
      script.requests.filter(
        (item) => item.request.modelId === "executor-model",
      ),
    ).toHaveLength(executorRequests);
  });
  it("cancels a durable question without calling any model or accepting a late answer", async () => {
    script.mode = "input";
    const { root, host } = fixture("openai-chat-completions");
    const session = await host.createSession({ backendWorkspace: root });
    await session.submitText("Ask me");
    const pending = session.getPendingUserInput?.();
    const answer = {
      schemaVersion: 1,
      requestId: pending!.requestId,
      sessionId: pending!.sessionId,
      turnId: pending!.turnId,
      action: "cancel",
      answers: [],
    };
    await session.answerUserInput?.(answer);
    expect(session.getPendingUserInput?.()).toBeNull();
    expect(script.requests).toHaveLength(1);
    await host.closeActiveSession();
    const reopened = await host.openSession({ sessionId: session.sessionId });
    await expect(
      reopened.answerUserInput?.({
        ...answer,
        action: "answer",
        answers: [{ questionId: "q", optionIds: ["a"] }],
      }),
    ).rejects.toThrow();
    expect(script.requests).toHaveLength(1);
  });
  it.each([
    "openai-responses",
    "openai-chat-completions",
    "anthropic-messages",
  ] as const)("%s persists a question across reopen and continues once with the structured answer", async (protocol) => {
    script.mode = "input";
    const { root, host } = fixture(protocol);
    const session = await host.createSession({ backendWorkspace: root });
    await session.submitText("Ask me for a choice");
    const pending = session.getPendingUserInput?.();
    expect(pending?.state).toBe("waiting_for_input");
    expect(script.requests).toHaveLength(1);
    await expect(session.submitText("bypass question")).rejects.toThrow(
      "请先回答",
    );
    await host.closeActiveSession();
    const reopened = await host.openSession({ sessionId: session.sessionId });
    expect(reopened.getPendingUserInput?.()).toEqual(pending);
    const answer = {
      schemaVersion: 1,
      requestId: pending!.requestId,
      sessionId: pending!.sessionId,
      turnId: pending!.turnId,
      action: "defer",
      answers: [],
    };
    await reopened.answerUserInput?.(answer);
    expect(script.requests).toHaveLength(1);
    await expect(
      reopened.answerUserInput?.({ ...answer, turnId: "stale" }),
    ).rejects.toThrow();
    const submitted = {
      ...answer,
      action: "answer",
      answers: [{ questionId: "q", optionIds: ["a"], text: "中文" }],
    };
    await reopened.answerUserInput?.(submitted);
    await until(() => !reopened.turnInFlight);
    expect(reopened.getPendingUserInput?.()).toBeNull();
    expect(script.requests).toHaveLength(2);
    expect(
      script.requests[1]?.request.messages.some(
        (m) =>
          m.role === "tool" &&
          m.toolCallId === "input-1" &&
          JSON.stringify(m.result).includes("中文"),
      ),
    ).toBe(true);
    await expect(reopened.answerUserInput?.(submitted)).rejects.toThrow();
    await host.closeActiveSession();
    const final = await host.openSession({ sessionId: session.sessionId });
    expect(final.getPendingUserInput?.()).toBeNull();
    expect(script.requests).toHaveLength(2);
  });
  it("native private blocks stay in their role/turn and never enter persisted neutral history", async () => {
    const { root, host, config } = fixture(
      "anthropic-messages",
      "openai-responses",
    );
    const session = await host.createSession({ backendWorkspace: root });
    await session.setWorkspaceTrust?.("workspace");
    await session.submitText("Create a file.");
    const personaRequests = script.requests.filter(
      ({ request }) => request.modelId === "persona-model",
    );
    const executorRequests = script.requests.filter(
      ({ request }) => request.modelId === "executor-model",
    );
    expect(personaRequests[0]?.request.nativeContext).toBeUndefined();
    expect(personaRequests[1]?.request.nativeContext?.providerId).toBe(
      "persona",
    );
    expect(executorRequests[0]?.request.nativeContext).toBeUndefined();
    expect(executorRequests[1]?.request.nativeContext?.providerId).toBe(
      "executor",
    );
    expect(
      readFileSync(
        join(config.transcriptDir, `${session.sessionId}.jsonl`),
        "utf8",
      ),
    ).not.toContain("private-reasoning-test-block");
    const count = script.requests.length;
    script.mode = "chat";
    await session.submitText("Next conversation");
    expect(script.requests[count]?.request.nativeContext).toBeUndefined();
  });
  it("explicit approval runs a real child command and supplies actual stdout to the executor", async () => {
    script.mode = "command";
    const { root, host } = fixture("openai-responses");
    const session = await host.createSession({ backendWorkspace: root });
    const running = session.submitText("Run the check command.");
    await until(() => session.overlay !== null);
    const overlay = session.overlay;
    if (overlay && overlay.kind !== "idle")
      await session.resolveApproval({
        requestId: overlay.requestId,
        decision: "allow",
      });
    await running;
    const outputs = script.requests.flatMap(({ request }) =>
      request.messages.filter((message) => message.role === "tool"),
    );
    expect(JSON.stringify(outputs)).toContain(
      "R3 actual child command evidence",
    );
    expect(script.releases).toBe(1);
  });
  it("an existing uncommitted file is preserved when write_new_file targets it", async () => {
    const { root, host } = fixture("anthropic-messages");
    writeFileSync(
      join(root, "中文（验证）.txt"),
      "owner modification\n",
      "utf8",
    );
    const session = await host.createSession({ backendWorkspace: root });
    await session.setWorkspaceTrust?.("workspace");
    await session.submitText("Create a file.");
    expect(readFileSync(join(root, "中文（验证）.txt"), "utf8")).toBe(
      "owner modification\n",
    );
    const outputs = script.requests.flatMap(({ request }) =>
      request.messages.filter((message) => message.role === "tool"),
    );
    expect(
      outputs.some((message) => message.role === "tool" && !message.result.ok),
    ).toBe(true);
  });
  it("interrupted executor journal resumes only explicitly and does not repeat a completed write", async () => {
    script.mode = "interrupt-executor";
    const { root, host } = fixture("openai-chat-completions");
    const session = await host.createSession({ backendWorkspace: root });
    await session.setWorkspaceTrust?.("workspace");
    const running = session.submitText("Create a file.");
    const rejected = expect(running).rejects.toBeDefined();
    await until(
      () =>
        script.requests.filter(
          ({ request }) => request.modelId === "executor-model",
        ).length > 1,
    );
    await session.interrupt();
    await rejected;
    await until(() => session.resumable === true);
    expect(session.resumable).toBe(true);
    const bytes = readFileSync(join(root, "中文（验证）.txt"), "utf8");
    const mtime = statSync(join(root, "中文（验证）.txt")).mtimeMs;
    await host.closeActiveSession();
    const count = script.requests.length;
    const reopened = await host.openSession({ sessionId: session.sessionId });
    await reopened.regenerateLastReplyIfOrphaned?.();
    expect(script.requests).toHaveLength(count);
    script.mode = "delegate";
    await reopened.continueInterrupted?.();
    expect(readFileSync(join(root, "中文（验证）.txt"), "utf8")).toBe(bytes);
    expect(statSync(join(root, "中文（验证）.txt")).mtimeMs).toBe(mtime);
    const recovery = [...reopened.record]
      .reverse()
      .find((block) => block.kind === "system" && block.recoverySummary);
    expect(
      recovery?.kind === "system" && recovery.recoverySummary?.steps,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callId: "write-1",
          phase: "previously-completed",
          outcome: "succeeded",
        }),
      ]),
    );
    const resumedExecutor = script.requests
      .slice(count)
      .filter(({ request }) => request.modelId === "executor-model");
    expect(resumedExecutor).toHaveLength(1);
    expect(
      resumedExecutor[0]?.request.messages.some(
        (message) =>
          message.role === "tool" && message.toolCallId === "write-1",
      ),
    ).toBe(true);
    await until(() => reopened.resumable === false);
    expect(reopened.resumable).toBe(false);
    await host.closeActiveSession();
    const persisted = await host.openSession({ sessionId: session.sessionId });
    expect(
      persisted.record.some(
        (block) =>
          block.kind === "system" &&
          block.recoverySummary?.steps.some(
            (step) =>
              step.callId === "write-1" &&
              step.phase === "previously-completed",
          ),
      ),
    ).toBe(true);
  });
  it("active snapshot is deeply frozen; edits affect only the following turn", async () => {
    script.mode = "cancel";
    const { root, host, persona } = fixture("openai-responses");
    const session = await host.createSession({ backendWorkspace: root });
    const running = session.submitText("Hello");
    const rejected = expect(running).rejects.toBeDefined();
    await until(() => script.requests.length > 0);
    Object.assign(persona, {
      baseURL: "https://example.invalid/changed/v1",
      revision: 2,
    });
    expect(script.requests[0]?.config.baseURL).toBe(
      "https://example.invalid/prefix/v1",
    );
    expect(Object.isFrozen(script.requests[0]?.config)).toBe(true);
    expect(Object.isFrozen(script.requests[0]?.config.defaults)).toBe(true);
    await session.interrupt();
    await rejected;
    script.mode = "chat";
    await session.submitText("Another turn");
    expect(script.requests.at(-1)?.config.baseURL).toBe(
      "https://example.invalid/changed/v1",
    );
    expect(script.releases).toBe(2);
  });
  it("session switch closes old lifecycle subscriptions and subsequent turns use the new session ID", async () => {
    script.mode = "chat";
    const { root, host } = fixture("openai-responses");
    const first = await host.createSession({ backendWorkspace: root });
    const oldLifecycle = first.subscribeTurnLifecycle()[Symbol.asyncIterator]();
    const waiting = oldLifecycle.next();
    const second = await host.createSession({ backendWorkspace: root });
    expect(second.sessionId).not.toBe(first.sessionId);
    expect((await waiting).done).toBe(true);
    await second.submitText("Hello from the new task");
    expect(
      script.requests.every(
        ({ request }) => request.sessionId === second.sessionId,
      ),
    ).toBe(true);
    expect(first.record).toHaveLength(0);
    expect(
      second.record.some(
        (block) =>
          block.kind === "user" && block.text === "Hello from the new task",
      ),
    ).toBe(true);
  });
  it("text-only persona with tools executor never sends native tools or tool messages to persona", async () => {
    script.mode = "text-only";
    const { root, host } = fixture(
      "anthropic-messages",
      "openai-chat-completions",
    );
    const session = await host.createSession({ backendWorkspace: root });
    await session.setWorkspaceTrust?.("workspace");
    await session.submitText("Create a file.");
    expect(readFileSync(join(root, "中文（验证）.txt"), "utf8")).toBe(
      "real isolated filesystem\n",
    );
    const personaCalls = script.requests.filter(
      ({ request }) => request.modelId === "persona-model",
    );
    expect(personaCalls).toHaveLength(2);
    expect(
      personaCalls.every(
        ({ request }) =>
          request.tools.length === 0 &&
          request.messages.every(
            (message) =>
              message.role !== "tool" &&
              (message.role !== "assistant" || message.toolCalls.length === 0),
          ),
      ),
    ).toBe(true);
    expect(
      personaCalls[1]?.request.messages.some(
        (message) =>
          message.role === "user" &&
          message.text.includes("Actual executor evidence"),
      ),
    ).toBe(true);
  });
  it.each([
    "openai-responses",
    "openai-chat-completions",
    "anthropic-messages",
  ] as const)("%s text-only questions persist and continue without native tools", async (protocol) => {
    script.mode = "text-only-input";
    const { root, host } = fixture(protocol);
    const session = await host.createSession({ backendWorkspace: root });
    await session.submitText("Ask for my choice");
    const pending = session.getPendingUserInput?.();
    expect(pending?.questions[0]?.id).toBe("q");
    await host.closeActiveSession();
    const reopened = await host.openSession({ sessionId: session.sessionId });
    expect(reopened.getPendingUserInput?.()).toEqual(pending);
    await reopened.answerUserInput?.({
      schemaVersion: 1,
      requestId: pending!.requestId,
      sessionId: pending!.sessionId,
      turnId: pending!.turnId,
      action: "answer",
      answers: [{ questionId: "q", optionIds: ["a"], text: "中文选择" }],
    });
    await until(() => !reopened.turnInFlight);
    expect(reopened.getPendingUserInput?.()).toBeNull();
    expect(script.requests).toHaveLength(2);
    for (const { request } of script.requests) {
      expect(request.system).toContain("默认使用简体中文回复");
      expect(request.tools).toEqual([]);
      expect(
        request.messages.every(
          (m) =>
            m.role !== "tool" &&
            (m.role !== "assistant" || m.toolCalls.length === 0),
        ),
      ).toBe(true);
    }
    expect(JSON.stringify(script.requests[1]?.request.messages)).toContain(
      "中文选择",
    );
  });
  it("text-only persona can ask after execution and never repeats the completed write", async () => {
    script.mode = "text-only-after-write";
    const { root, host } = fixture("openai-chat-completions");
    const session = await host.createSession({ backendWorkspace: root });
    await session.setWorkspaceTrust?.("workspace");
    await session.submitText("Write then ask");
    const pending = session.getPendingUserInput?.();
    expect(pending).not.toBeNull();
    const file = join(root, "中文（验证）.txt");
    const modified = statSync(file).mtimeMs;
    await session.answerUserInput?.({
      schemaVersion: 1,
      requestId: pending!.requestId,
      sessionId: pending!.sessionId,
      turnId: pending!.turnId,
      action: "answer",
      answers: [{ questionId: "q", optionIds: ["a"] }],
    });
    await until(() => !session.turnInFlight);
    expect(statSync(file).mtimeMs).toBe(modified);
    expect(
      script.requests.filter((r) => r.request.modelId === "executor-model"),
    ).toHaveLength(2);
  });
  it("rejects text plans that ask and execute together before side effects", async () => {
    script.mode = "text-only-invalid";
    const { root, host } = fixture("openai-chat-completions");
    const session = await host.createSession({ backendWorkspace: root });
    await expect(session.submitText("ambiguous plan")).rejects.toThrow();
    expect(session.getPendingUserInput?.()).toBeNull();
    expect(script.requests).toHaveLength(1);
    expect(existsSync(join(root, "中文（验证）.txt"))).toBe(false);
  });
  for (const protocol of [
    "openai-responses",
    "openai-chat-completions",
    "anthropic-messages",
  ] as const) {
    it(`${protocol}: persona → actual executor write → evidence → conclusion, no legacy key`, async () => {
      const { root, host } = fixture(protocol);
      const session = await host.createSession({ backendWorkspace: root });
      await session.setWorkspaceTrust?.("workspace");
      const result = await session.submitText(
        "Create the requested test file.",
      );
      expect("turnId" in result).toBe(true);
      expect(readFileSync(join(root, "中文（验证）.txt"), "utf8")).toBe(
        "real isolated filesystem\n",
      );
      expect(
        script.requests.every(({ config }) => config.protocol === protocol),
      ).toBe(true);
      expect(
        script.requests.some(
          ({ request }) => request.modelId === "executor-model",
        ),
      ).toBe(true);
      for (const { request } of script.requests) {
        if (request.modelId === "persona-model") {
          expect(request.system).toContain("Great Herta-inspired collaborator");
          expect(request.system).toContain("默认使用简体中文回复");
          expect(request.system).toContain("Delegate whenever");
        } else {
          expect(request.system).not.toContain(
            "Great Herta-inspired collaborator",
          );
        }
      }
      const conclusion = script.requests.at(-1)?.request;
      expect(
        conclusion?.messages.some(
          (message) =>
            message.role === "tool" &&
            message.result.summary.includes("中文（验证）.txt"),
        ),
      ).toBe(true);
      expect(
        script.requests.every(
          ({ request }) =>
            request.turnId === ("turnId" in result ? result.turnId : ""),
        ),
      ).toBe(true);
      expect(script.releases).toBe(1);
    });
  }
  it("preserves the session language in persona prompts after reopening", async () => {
    script.mode = "input";
    const { root, host } = fixture("anthropic-messages");
    const session = await host.createSession({
      backendWorkspace: root,
      lang: "en",
    });
    await session.submitText("Ask me");
    const pending = session.getPendingUserInput?.();
    expect(script.requests[0]?.request.system).toContain("default to English");
    await host.closeActiveSession();
    const reopened = await host.openSession({
      sessionId: session.sessionId,
      lang: "zh",
    });
    await reopened.answerUserInput?.({
      schemaVersion: 1,
      requestId: pending!.requestId,
      sessionId: pending!.sessionId,
      turnId: pending!.turnId,
      action: "answer",
      answers: [{ questionId: "q", optionIds: ["a"] }],
    });
    await until(() => !reopened.turnInFlight);
    expect(script.requests.at(-1)?.request.system).toContain(
      "default to English",
    );
    expect(script.requests.at(-1)?.request.system).toContain(
      "Follow the user's explicit language preference",
    );
  });
  it("mixed bindings remain independent and history reopens without API or operation replay", async () => {
    const { root, host, config } = fixture(
      "anthropic-messages",
      "openai-responses",
    );
    const session = await host.createSession({ backendWorkspace: root });
    await session.setWorkspaceTrust?.("workspace");
    await session.submitText("Create a file.");
    const id = session.sessionId;
    expect(
      script.requests.find(({ request }) => request.modelId === "persona-model")
        ?.config.protocol,
    ).toBe("anthropic-messages");
    expect(
      script.requests.find(
        ({ request }) => request.modelId === "executor-model",
      )?.config.protocol,
    ).toBe("openai-responses");
    await host.renameSession?.(id, "Recorded task");
    await host.closeActiveSession();
    const requests = script.requests.length;
    const restarted = createSessionHost(config);
    hosts.push(restarted);
    const reopened = await restarted.openSession({ sessionId: id });
    await reopened.regenerateLastReplyIfOrphaned?.();
    expect(reopened.title).toBe("Recorded task");
    // Existing sink/persister stamp independently; compare every durable content
    // field, and separately require timestamps on the reloaded record.
    const content = (record: typeof session.record) =>
      record.map(({ at: _at, ...block }) => block);
    expect(content(reopened.record)).toEqual(content(session.record));
    expect(reopened.record.every((block) => typeof block.at === "string")).toBe(
      true,
    );
    expect(script.requests).toHaveLength(requests);
    expect(
      restarted.listSessions().some((entry) => entry.sessionId === id),
    ).toBe(true);
  });
  it("approval rejection causes no filesystem mutation", async () => {
    const { root, host } = fixture("openai-chat-completions");
    const session = await host.createSession({ backendWorkspace: root });
    const running = session.submitText("Create a file.");
    await until(() => session.overlay !== null);
    const overlay = session.overlay;
    expect(overlay).not.toBeNull();
    if (overlay && overlay.kind !== "idle")
      await session.resolveApproval({
        requestId: overlay.requestId,
        decision: "deny",
      });
    await running;
    expect(existsSync(join(root, "中文（验证）.txt"))).toBe(false);
    expect(script.releases).toBe(1);
  });
  it("invalid persona tool payload never dispatches executor", async () => {
    script.mode = "malformed";
    const { root, host } = fixture("openai-responses");
    const session = await host.createSession({ backendWorkspace: root });
    await expect(session.submitText("Create a file.")).rejects.toThrow(
      "Invalid persona delegation",
    );
    expect(existsSync(join(root, "中文（验证）.txt"))).toBe(false);
    expect(script.requests).toHaveLength(1);
    expect(script.releases).toBe(1);
  });
  it("stream failure persists partial reply and reopen never replays", async () => {
    script.mode = "fail";
    const { root, host } = fixture("anthropic-messages");
    const session = await host.createSession({ backendWorkspace: root });
    await expect(session.submitText("Hello")).rejects.toThrow(
      "Synthetic transport disconnected",
    );
    expect(session.record.at(-1)).toMatchObject({
      kind: "herta",
      text: "partial response",
    });
    await host.closeActiveSession();
    const reopened = await host.openSession({ sessionId: session.sessionId });
    await reopened.regenerateLastReplyIfOrphaned?.();
    expect(script.requests).toHaveLength(1);
    expect(script.releases).toBe(1);
  });
  it("interrupt cancels streaming and releases frozen provider lease", async () => {
    script.mode = "cancel";
    const { root, host } = fixture("openai-chat-completions");
    const session = await host.createSession({ backendWorkspace: root });
    const running = session.submitText("Hello");
    const rejection = expect(running).rejects.toBeDefined();
    await until(() => script.requests.length > 0);
    await session.interrupt();
    await rejection;
    expect(session.turnInFlight).toBe(false);
    expect(script.releases).toBe(1);
  });
});
