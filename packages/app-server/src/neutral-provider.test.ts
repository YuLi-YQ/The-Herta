import type { BackendPromptFrame, ToolCallRequest } from "@herta/core";
import type {
  ModelRequest,
  NativeContext,
  ProtocolAdapter,
  ProviderConfig,
  ProviderProtocol,
} from "@herta/providers";
import { describe, expect, it } from "vitest";
import { NeutralBackendProvider } from "./neutral-provider.js";

function config(protocol: ProviderProtocol): ProviderConfig {
  return {
    id: "executor",
    name: "Executor",
    protocol,
    baseURL: "https://example.invalid/prefix/v1",
    authentication: "none",
    credentialRef: null,
    allowRemoteHTTP: false,
    revision: 1,
    models: [],
    defaults: { model: "executor-model", timeoutMs: 1000 },
  };
}
async function consume(
  provider: NeutralBackendProvider,
  frame: BackendPromptFrame,
) {
  for await (const _event of provider.streamChat(
    frame,
    new AbortController().signal,
  )) {
    /* drain finished context */
  }
}
describe("NeutralBackendProvider real frame/protocol boundary", () => {
  for (const protocol of [
    "openai-responses",
    "openai-chat-completions",
    "anthropic-messages",
  ] as const) {
    it(`${protocol}: empty initial frame has a nonempty user anchor; assistant-first continuation keeps the exact anchor and private ownership`, async () => {
      const connection = config(protocol);
      const requests: ModelRequest[] = [];
      const native: NativeContext = {
        providerId: connection.id,
        providerRevision: connection.revision,
        protocol,
        modelId: "executor-model",
        opaque: { private: "same-role-continuation" },
      };
      const adapter: ProtocolAdapter = {
        protocol,
        listModels: async () => ({ models: [], nextCursor: null }),
        async *stream(request) {
          requests.push(request);
          yield { type: "finished", reason: "stop", nativeContext: native };
        },
      };
      const provider = new NeutralBackendProvider(() => adapter);
      provider.turn = {
        snapshot: {
          sessionId: "actual-session",
          turnId: "actual-turn",
          bindings: {
            persona: { providerId: "persona", modelId: "persona-model" },
            executor: { providerId: connection.id, modelId: "executor-model" },
          },
          persona: connection,
          executor: connection,
        },
        personaKey: null,
        executorKey: null,
      };
      const first: BackendPromptFrame = {
        backendSystem:
          "Current actual user task and execution contract are quoted here.",
        scopedRepoInstructions: "",
        scopedMemory: "",
        messages: [],
        toolSchemas: [],
      };
      await consume(provider, first);
      expect(requests[0]?.messages).toHaveLength(1);
      expect(requests[0]?.messages[0]).toMatchObject({ role: "user" });
      expect(
        requests[0]?.messages[0]?.role === "user" &&
          requests[0].messages[0].text.trim().length > 0,
      ).toBe(true);
      expect(requests[0]?.system).toBe(first.backendSystem);
      const call: ToolCallRequest = {
        id: "read-actual",
        tool: "read_file",
        input: { path: "package.json" },
      };
      const continuation: BackendPromptFrame = {
        ...first,
        trailingState: "One tool result is available.",
        messages: [
          {
            role: "assistant",
            text: "Inspecting the requested project",
            toolCalls: [call],
            ts: "2026-10-04T00:00:00Z",
          },
          {
            role: "tool",
            toolCallId: call.id,
            result: { ok: true, summary: "Recorded file content" },
            ts: "2026-10-04T00:00:01Z",
          },
        ],
      };
      await consume(provider, continuation);
      expect(requests[1]?.messages[0]).toEqual(requests[0]?.messages[0]);
      expect(requests[1]?.messages.slice(1)).toEqual([
        {
          role: "assistant",
          text: "Inspecting the requested project",
          toolCalls: [call],
        },
        {
          role: "tool",
          toolCallId: call.id,
          result: { ok: true, summary: "Recorded file content" },
        },
      ]);
      expect(requests[1]?.nativeContext).toBe(native);
      expect(first.messages).toHaveLength(0);
      expect(continuation.messages).toHaveLength(2);
      provider.turn = {
        ...provider.turn,
        snapshot: { ...provider.turn.snapshot, turnId: "following-turn" },
      };
      await consume(provider, first);
      expect(requests[2]?.nativeContext).toBeUndefined();
      expect(requests[2]?.messages[0]).toEqual(requests[0]?.messages[0]);
    });
  }
});
