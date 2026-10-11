import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderPromptFrame,
} from "@herta/core";
import {
  createProtocolAdapter,
  type ModelRequest,
  type NativeContext,
  type NeutralMessage,
  type ProtocolAdapter,
  type ProviderConfig,
} from "@herta/providers";
import { beginNeutralUsage } from "./neutral-usage.js";
import type { AppServerConfig } from "./types.js";

export type TurnResolution = Awaited<
  ReturnType<NonNullable<AppServerConfig["neutralProviders"]>["resolveTurn"]>
>;

/** The real brief/user history is carried by backendSystem. Keep this anchor
 * identical on every sampling step so message ownership/fingerprints remain
 * stable and protocols requiring a first user message can consume the frame. */
const EXECUTION_USER_ANCHOR: NeutralMessage = Object.freeze({
  role: "user",
  text: "Execute the current user task described in the system execution contract and quoted user history. Continue from the recorded tool results; do not repeat completed side effects.",
});

export function ownedNativeContext(
  context: NativeContext | undefined,
  config: ProviderConfig,
  modelId: string,
): NativeContext | undefined {
  return context &&
    context.providerId === config.id &&
    context.providerRevision === config.revision &&
    context.protocol === config.protocol &&
    context.modelId === modelId
    ? context
    : undefined;
}

/** Mutable holder is installed once; each turn installs its immutable snapshot. */
export class NeutralBackendProvider implements ProviderAdapter {
  onPublicReasoning?: (
    id: string,
    text: string,
    format: "text" | "summary",
  ) => void;
  turn: TurnResolution | null = null;
  private contextTurnId: string | null = null;
  private nativeContext: NativeContext | undefined;
  constructor(
    private readonly adapterFactory = createProtocolAdapter,
    private readonly usageLogPath?: string,
  ) {}
  async *streamChat(
    frame: ProviderPromptFrame,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const turn = this.turn;
    if (!turn) throw new Error("No active frozen provider snapshot");
    const config = turn.snapshot.executor;
    if (this.contextTurnId !== turn.snapshot.turnId) {
      this.nativeContext = undefined;
      this.contextTurnId = turn.snapshot.turnId;
    }
    const adapter: ProtocolAdapter = this.adapterFactory(
      config,
      turn.executorKey,
    );
    const system =
      "backendSystem" in frame
        ? [
            frame.backendSystem,
            frame.scopedRepoInstructions,
            frame.scopedMemory,
            frame.trailingState,
          ]
            .filter(Boolean)
            .join("\n\n")
        : [
            frame.stableSystem,
            frame.repoInstructions,
            frame.memoryContext,
            frame.retrievedLore,
          ]
            .filter(Boolean)
            .join("\n\n");
    const request: ModelRequest = {
      sessionId: turn.snapshot.sessionId,
      turnId: turn.snapshot.turnId,
      modelId: turn.snapshot.bindings.executor.modelId,
      system: `${system}\nIf a required human decision is missing, stop execution and report the exact missing information to The Herta persona. Do not guess it or proceed with side effects; the persona will request structured user input.`,
      messages: [
        EXECUTION_USER_ANCHOR,
        ...frame.messages.map((message): NeutralMessage => {
          if (message.role === "user")
            return { role: "user", text: message.text };
          if (message.role === "assistant")
            return {
              role: "assistant",
              text: message.text,
              toolCalls: message.toolCalls,
            };
          return {
            role: "tool",
            toolCallId: message.toolCallId,
            result: message.result,
          };
        }),
      ],
      tools: frame.toolSchemas,
      options: {
        ...config.defaults,
        reasoningEffort: turn.snapshot.bindings.executor.reasoningEffort,
      },
      signal,
      ...(ownedNativeContext(
        this.nativeContext,
        config,
        turn.snapshot.bindings.executor.modelId,
      )
        ? { nativeContext: this.nativeContext }
        : {}),
    };
    const usage = beginNeutralUsage(this.usageLogPath, {
      sessionId: request.sessionId,
      turnId: request.turnId,
      protocol: config.protocol,
      modelId: request.modelId,
      role: "executor",
      providerId: config.id,
      providerRevision: config.revision,
      baseURL: config.baseURL,
    });
    try {
      for await (const ev of adapter.stream(request)) {
        if (ev.type === "public-reasoning-delta")
          this.onPublicReasoning?.(usage.requestId, ev.text, ev.format);
        if (ev.type === "usage") usage.record(ev);
        if (ev.type === "text-delta") yield ev;
        else if (ev.type === "tool-arguments-delta")
          yield {
            type: "tool-call-delta",
            id: ev.callId,
            tool: ev.tool,
            argsDelta: ev.delta,
          };
        else if (ev.type === "tool-call-ready")
          yield { type: "tool-call-request", call: ev.call };
        else if (ev.type === "finished") {
          this.nativeContext = ownedNativeContext(
            ev.nativeContext,
            config,
            request.modelId,
          );
          yield {
            type: "finish",
            reason: ev.reason === "tool-calls" ? "tool_calls" : ev.reason,
          };
        }
      }
    } finally {
      await usage.finish();
    }
  }
}
