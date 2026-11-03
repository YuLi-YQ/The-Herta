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
import { colorsNamed, quadrantPicture } from "./probe-image.js";
import { safeProviderFailure } from "./provider-errors.js";
import { recordImageCheck } from "./provider-image-checks.js";
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
/** The model answered but did not complete the probe's contract: a fact about the model. */
class ProbeContractError extends Error {}
/** Missing completion or an exhausted output budget is inconclusive, not a capability verdict. */
class ProbeIncompleteError extends Error {}
/**
 * R104 (F06): why a probe did not pass. Only "contract" and "rejected" say something about the
 * model; a credential, network, timeout, rate-limit or server failure (and anything unrecognised)
 * leaves the saved result alone, so one bad connection moment cannot make a working model unusable.
 */
type ProbeFailure = "contract" | "rejected" | "authentication" | "transient";
function classifyProbeFailure(error: unknown): ProbeFailure {
  if (error instanceof ProbeIncompleteError) return "transient";
  if (error instanceof ProbeContractError) return "contract";
  const failure = safeProviderFailure(error);
  if (failure.code === "authentication") return "authentication";
  if (
    failure.code === "model-not-found" ||
    [400, 413, 415, 422].includes(failure.status ?? 0)
  )
    return "rejected";
  if (failure.code.startsWith("tool-") || failure.code === "protocol-incompatible")
    return "contract";
  return "transient";
}
/** R104 (F06): only the latest started probe of a model may save. Text and tools share
 *  `validation`; images write only `capabilities.images`. */
const latestProbe = new Map<string, number>();
let probeSerial = 0;
function startProbe(providerId: string, modelId: string, group: "validation" | "images") {
  const key = `${providerId}\u0000${modelId}\u0000${group}`;
  const serial = ++probeSerial;
  latestProbe.set(key, serial);
  return () => latestProbe.get(key) === serial;
}
/** A probe that saves nothing still answers for the revision it was asked about. */
function unsaved(
  input: ProviderProbeInput,
  extra: Pick<ProviderProbeResult, "kept" | "superseded">,
): ProviderProbeResult {
  const p = selected(input);
  const validation = p.models.find((m) => m.id === input.modelId)?.validation;
  if (!validation) throw new Error("验证模型不存在。");
  return { view: getProviderSettings(), validation, ...extra };
}
/** R104 (F06): a failure that counts against the model says what the model or server did, not the
 *  generic "check the connection" text, which would send the user after the wrong fix. */
function probeDiagnostic(error: unknown, kind: "text" | "tools" | "images"): string {
  if (classifyProbeFailure(error) === "contract")
    return kind === "tools"
      ? "模型有回复，但没有按要求调用测试工具，工具能力未确认。"
      : kind === "images"
        ? "模型没有正确说出测试图片的颜色，图片可能未被读取。"
        : "模型有回复，但没有按要求完成验证回复。";
  const { status } = safeProviderFailure(error);
  if (status && [400, 413, 415, 422].includes(status))
    return `服务拒绝了这次验证请求（HTTP ${status}），该模型或端点可能不支持这项能力。`;
  return diagnostic(error);
}
/** Generic diagnostics deliberately exclude remote bodies, URLs and credentials. */
function diagnostic(error: unknown, discovery = false): string {
  if (error instanceof ProbeIncompleteError)
    return "验证回复未正常结束或达到输出上限，能力尚未重新确认。请稍后手动重试。";
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
    !["text", "tools", "images"].includes(input.kind) ||
    !p.models.some((m) => m.id === input.modelId)
  )
    throw new Error("模型验证参数无效。");
  if (input.kind === "images") return probeImages(input, p, factory);
  const latest = startProbe(p.id, input.modelId, "validation");
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
      if (finished) throw new ProbeContractError("Events after completion");
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
          throw new ProbeContractError("Invalid validation tool");
        toolReady = true;
      }
      if (event.type === "finished") {
        finished = true;
        reason = event.reason;
      }
    }
    if (!finished || reason === "length") throw new ProbeIncompleteError();
    if (
      (input.kind === "text"
        ? !text.trim() || toolReady || reason !== "stop"
        : !toolReady || reason !== "tool-calls")
    )
      throw new ProbeContractError("Probe did not complete its contract");
  } catch (error) {
    failure = error;
  }
  if (!latest()) return unsaved(input, { superseded: true });
  const kind = failure ? classifyProbeFailure(failure) : undefined;
  if (kind === "authentication" || kind === "transient")
    return unsaved(input, { kept: { reason: kind, diagnostic: diagnostic(failure) } });
  const validation: ModelValidation = {
    state: failure
      ? "failed"
      : input.kind === "tools"
        ? "tools-available"
        : "text-available",
    protocol: p.protocol,
    providerRevision: p.revision,
    checkedAt: new Date().toISOString(),
    ...(failure ? { diagnostic: probeDiagnostic(failure, input.kind) } : {}),
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
                : // A failed tool probe says nothing against a current text result (F06).
                  failure &&
                    input.kind === "tools" &&
                    ["text-available", "tools-available"].includes(m.validation.state) &&
                    m.validation.providerRevision === p.revision &&
                    m.validation.protocol === p.protocol
                  ? {
                      ...m.validation,
                      state: "text-available",
                      diagnostic: probeDiagnostic(failure, "tools"),
                    }
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

/**
 * Image probe: send a generated picture as a real image block and require its four colours
 * back in order. Passing is the only way a model outside the documented list gets image input
 * (`imageSupport`); text and tool probes say nothing about it. The model's text/tool validation
 * is left as it was either way.
 */
async function probeImages(
  input: ProviderProbeInput,
  p: ProviderConfig,
  factory: AdapterFactory,
): Promise<ProviderProbeResult> {
  const { modelId } = input;
  const latest = startProbe(p.id, modelId, "images");
  const nonce = randomUUID();
  const picture = quadrantPicture();
  let text = "",
    finished = false,
    reason: string | undefined,
    failure: unknown;
  try {
    const adapter = factory(
      // The adapter refuses image blocks for a model it does not know can read them; the
      // probe is how that becomes known, so this one request is let through.
      {
        ...p,
        models: p.models.map((m) =>
          m.id === modelId
            ? { ...m, capabilities: { ...m.capabilities, images: "supported" as const } }
            : m,
        ),
      },
      resolveProviderCredential(p),
    );
    for await (const event of adapter.stream({
      sessionId: `probe-${nonce}`,
      turnId: nonce,
      modelId,
      system:
        "You are checking image input. Answer only from the attached picture.",
      messages: [
        {
          role: "user",
          text: "The attached picture is split into four equal squares. Name the colour of each square in this order: top-left, top-right, bottom-left, bottom-right. Use only these words: red, green, blue, yellow, black, white. Reply with the four words separated by spaces and nothing else.",
          images: [{ mimeType: "image/png", data: picture.png.toString("base64") }],
        },
      ],
      tools: [],
      options: { maxOutputTokens: 2048 },
      signal: AbortSignal.timeout(p.defaults.timeoutMs),
    })) {
      if (finished) throw new ProbeContractError("Events after completion");
      if (event.type === "text-delta") text += event.text;
      if (event.type === "finished") {
        finished = true;
        reason = event.reason;
      }
    }
    if (!finished || reason === "length") throw new ProbeIncompleteError();
    if (reason !== "stop")
      throw new ProbeContractError("Probe did not complete its contract");
  } catch (error) {
    failure = error;
  }
  if (!latest()) return unsaved(input, { superseded: true });
  const kind = failure ? classifyProbeFailure(failure) : undefined;
  if (kind === "authentication" || kind === "transient")
    return unsaved(input, { kept: { reason: kind, diagnostic: diagnostic(failure) } });
  const named = colorsNamed(text);
  const supported =
    !failure &&
    named.length === 4 &&
    named.every((color, i) => color === picture.colors[i]);
  const saved = updateProviderModels(p.id, p.revision, (models) =>
    models.map((m) =>
      m.id !== modelId
        ? m
        : {
            ...m,
            capabilities: {
              ...m.capabilities,
              images: supported ? ("supported" as const) : ("unsupported" as const),
            },
          },
    ),
  );
  // R109 (F06): the verdict's date and connection go beside the settings, never into them, so
  // an older version can still read the settings after a rollback (provider-image-checks.ts).
  recordImageCheck(saved.settings, p.id, modelId, supported ? "supported" : "unsupported");
  const view = getProviderSettings();
  const savedValidation = view.settings.providers
    .find((v) => v.id === p.id)
    ?.models.find((m) => m.id === modelId)?.validation;
  if (!savedValidation) throw new Error("验证模型不存在。");
  return {
    view,
    validation: savedValidation,
    images: supported
      ? { supported: true }
      : {
          supported: false,
          diagnostic: failure
            ? probeDiagnostic(failure, "images")
            : "模型没有正确说出测试图片的颜色，图片可能未被读取。",
        },
  };
}
