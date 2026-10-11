import { randomUUID } from "node:crypto";
import {
  createProtocolAdapter,
  type ModelValidation,
  type ProtocolAdapter,
  type ProviderConfig,
} from "@herta/providers";
import type {
  DiscoverProviderModelsInput,
  DiscoverProviderModelsResult,
  ValidateProviderModelInput,
  ValidateProviderModelResult,
} from "../shared/provider-settings-ipc.js";
import { safeProviderFailure } from "./provider-errors.js";
import {
  getProviderSettings,
  resolveProviderCredential,
  updateProviderModels,
} from "./provider-settings.js";

type ProviderDiscoveryInput = DiscoverProviderModelsInput;
type ProviderProbeInput = ValidateProviderModelInput;
type ProviderDiscoveryResult = DiscoverProviderModelsResult;
type ProviderProbeResult = ValidateProviderModelResult;
type AdapterFactory = (
  config: ProviderConfig,
  key: string | null,
) => ProtocolAdapter;
const cache = new Map<
  string,
  { expires: number; models: { id: string; alias?: string }[] }
>();
function selected(input: ProviderDiscoveryInput) {
  if (
    !input ||
    typeof input.providerId !== "string" ||
    !Number.isInteger(input.expectedRevision)
  )
    throw new Error("Provider 验证参数无效。");
  const p = getProviderSettings().settings.providers.find(
    (p) => p.id === input.providerId,
  );
  if (!p || p.revision !== input.expectedRevision)
    throw new Error("Provider 配置已改变，请重新加载。");
  return p;
}
/** Generic diagnostics deliberately exclude remote bodies, URLs and credentials. */
function diagnostic(error: unknown, discovery = false): string {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number(error.status)
      : undefined;
  return discovery && (status === 403 || status === 404)
    ? "服务不提供模型列表；已保留手填模型。"
    : safeProviderFailure(error).message;
}
export async function discoverProviderModels(
  input: ProviderDiscoveryInput,
  factory: AdapterFactory = createProtocolAdapter,
): Promise<ProviderDiscoveryResult> {
  const p = selected(input);
  const key = `${p.id}:${p.revision}`;
  const previous = cache.get(key);
  if (!input.refresh && previous && previous.expires > Date.now())
    return {
      view: getProviderSettings(),
      models: previous.models,
      cached: true,
    };
  const signal = AbortSignal.timeout(p.defaults.timeoutMs);
  try {
    const adapter = factory(p, resolveProviderCredential(p));
    const models = new Map<string, { id: string; alias?: string }>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await adapter.listModels({
        signal,
        ...(cursor ? { cursor } : {}),
      });
      for (const m of result.models) {
        if (
          typeof m.id !== "string" ||
          !m.id.trim() ||
          m.id.length > 256 ||
          Array.from(m.id).some((character) => character.charCodeAt(0) < 32)
        )
          throw new Error("Invalid model list");
        // Optional remote display names must satisfy the same constraints as
        // the stored alias; an invalid label must never poison all settings.
        const alias =
          typeof m.alias === "string" &&
          m.alias.trim().length > 0 &&
          m.alias.trim().length <= 256 &&
          !Array.from(m.alias).some((character) => character.charCodeAt(0) < 32)
            ? m.alias.trim()
            : undefined;
        models.set(m.id, {
          id: m.id,
          ...(alias ? { alias } : {}),
        });
        if (models.size > 500) throw new Error("Model list too large");
      }
      if (!result.nextCursor) {
        cursor = undefined;
        break;
      }
      if (cursors.has(result.nextCursor)) throw new Error("Repeated cursor");
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    if (cursor) throw new Error("Incomplete model list");
    const list = [...models.values()];
    const view = updateProviderModels(p.id, p.revision, (existing) => [
      ...existing,
      ...list
        .filter((m) => !existing.some((e) => e.id === m.id))
        .map((m) => ({
          ...m,
          source: "discovered" as const,
          capabilities: {
            streaming: "unknown" as const,
            tools: "unknown" as const,
            images: "unknown" as const,
            reasoning: "unknown" as const,
          },
          validation: {
            state: "unverified" as const,
            protocol: p.protocol,
            providerRevision: p.revision,
          },
        })),
    ]);
    cache.set(key, { expires: Date.now() + 300_000, models: list });
    return { view, models: list, cached: false };
  } catch (error) {
    // An edited/deleted provider must not receive results from the old revision.
    selected(input);
    return {
      view: getProviderSettings(),
      models: p.models.map((m) => ({
        id: m.id,
        ...(m.alias ? { alias: m.alias } : {}),
      })),
      cached: false,
      diagnostic: diagnostic(error, true),
    };
  }
}
export async function validateProviderModel(
  input: ProviderProbeInput,
  factory: AdapterFactory = createProtocolAdapter,
): Promise<ProviderProbeResult> {
  const p = selected(input);
  if (
    !["text", "tools"].includes(input.kind) ||
    !p.models.some((m) => m.id === input.modelId)
  )
    throw new Error("模型验证参数无效。");
  const nonce = randomUUID();
  let text = "",
    finished = false,
    toolReady = false,
    observedStreaming = false;
  let reason: string | undefined;
  let failure: unknown;
  try {
    const adapter = factory(p, resolveProviderCredential(p));
    const signal = AbortSignal.timeout(p.defaults.timeoutMs);
    for await (const event of adapter.stream({
      sessionId: `probe-${nonce}`,
      turnId: nonce,
      modelId: input.modelId,
      system:
        input.kind === "tools"
          ? "Call herta_probe exactly once with the nonce from the user. Do not call any other tool. This tool only echoes a supplied string and has no local side effects."
          : "Reply with exactly HERTA_OK.",
      messages: [
        {
          role: "user",
          text:
            input.kind === "tools"
              ? `Use herta_probe with nonce ${nonce}.`
              : "Reply HERTA_OK.",
        },
      ],
      tools:
        input.kind === "tools"
          ? [
              {
                name: "herta_probe",
                description:
                  "Pure echo validation tool; no files, processes, network or workspace access.",
                inputSchema: {
                  type: "object",
                  properties: { nonce: { type: "string", enum: [nonce] } },
                  required: ["nonce"],
                  additionalProperties: false,
                },
              },
            ]
          : [],
      // Covers hidden reasoning budgets without guessing capabilities by model name.
      // Truncation still fails validation; a completed call is required.
      options: { maxOutputTokens: 2048 },
      signal,
    })) {
      if (finished) throw new Error("Events after completion");
      if (event.type === "text-delta") {
        observedStreaming = true;
        text += event.text;
      }
      if (event.type === "tool-call-ready") {
        if (
          toolReady ||
          event.call.tool !== "herta_probe" ||
          event.call.malformedArgs ||
          !event.call.input ||
          typeof event.call.input !== "object" ||
          Object.keys(event.call.input).length !== 1 ||
          (event.call.input as { nonce?: unknown }).nonce !== nonce
        )
          throw new Error("Invalid validation tool");
        toolReady = true;
      }
      if (event.type === "finished") {
        finished = true;
        reason = event.reason;
      }
    }
    if (
      !finished ||
      (input.kind === "text"
        ? !text.trim() || toolReady || reason !== "stop"
        : !toolReady || reason !== "tool-calls")
    )
      throw new Error("Probe did not complete its contract");
  } catch (error) {
    failure = error;
  }
  const validation: ModelValidation = {
    state: failure
      ? "failed"
      : input.kind === "tools"
        ? "tools-available"
        : "text-available",
    protocol: p.protocol,
    providerRevision: p.revision,
    checkedAt: new Date().toISOString(),
    ...(failure ? { diagnostic: diagnostic(failure) } : {}),
  };
  const view = updateProviderModels(p.id, p.revision, (models) =>
    models.map((m) =>
      m.id !== input.modelId
        ? m
        : {
            ...m,
            validation:
              !failure &&
              input.kind === "text" &&
              m.validation.state === "tools-available"
                ? { ...validation, state: "tools-available" }
                : validation,
            capabilities: {
              ...m.capabilities,
              ...(observedStreaming ? { streaming: "supported" as const } : {}),
              ...(input.kind === "tools"
                ? {
                    tools: failure
                      ? ("unknown" as const)
                      : ("supported" as const),
                  }
                : {}),
            },
          },
    ),
  );
  const savedValidation = view.settings.providers
    .find((v) => v.id === p.id)
    ?.models.find((m) => m.id === input.modelId)?.validation;
  if (!savedValidation) throw new Error("验证模型不存在。");
  return { view, validation: savedValidation };
}
