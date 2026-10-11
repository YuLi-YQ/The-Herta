import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  ModelBinding,
  ProviderConfig,
  ProviderModel,
  ProviderProtocol,
  ProviderSettings,
  RoleBindings,
  TurnProviderSnapshot,
} from "@herta/providers";
import { reasoningChoices } from "@herta/providers";
import { app, safeStorage } from "electron";
import type {
  ProviderReadiness,
  ProviderSettingsView,
  SaveProviderInput,
  SetProviderBindingsInput,
} from "../shared/provider-settings-ipc.js";

const activeProviders = new Map<string, number>();
const protocols = new Set([
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
]);
const empty = (): ProviderSettings => ({
  schemaVersion: 1,
  providers: [],
  defaultBindings: null,
  sessionBindings: {},
});
const root = () => app.getPath("userData");
const configPath = () => join(root(), "provider-settings.json");
const secretPath = (ref: string) => {
  if (!/^provider-[a-f0-9-]{36}$/.test(ref)) throw new Error("凭据引用无效。");
  return join(root(), "provider-credentials", `${ref}.enc`);
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("配置格式无效。");
  return value as Record<string, unknown>;
}
function onlyKeys(value: unknown, allowed: readonly string[]): void {
  if (Object.keys(object(value)).some((key) => !allowed.includes(key)))
    throw new Error("配置包含未知字段。");
}
function text(value: unknown, label: string, limit = 256): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > limit ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error(`${label}无效。`);
  return value.trim();
}
export function validateProviderURL(value: unknown, consent: unknown): string {
  const raw = text(value, "Base URL", 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Base URL 格式无效。");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Base URL 仅接受无凭据、查询参数或片段的 HTTP(S) API 根地址。",
    );
  if (/\/(responses|chat\/completions|messages|models)\/?$/i.test(url.pathname))
    throw new Error("请填写 API 根地址，不要粘贴完整请求端点。");
  const local =
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    /^127\./.test(url.hostname);
  if (url.protocol === "http:" && !local && consent !== true)
    throw new Error("远程 HTTP 会明文传输密钥；请明确同意后保存。");
  return url.toString().replace(/\/$/, "");
}
function protects(): boolean {
  return (
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" ||
      safeStorage.getSelectedStorageBackend() !== "basic_text")
  );
}
function atomicWrite(path: string, data: string | Buffer): void {
  mkdirSync(root(), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, data, { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
function load(): ProviderSettings {
  if (!existsSync(configPath())) return empty();
  try {
    const parsed = object(JSON.parse(readFileSync(configPath(), "utf8")));
    onlyKeys(parsed, [
      "schemaVersion",
      "providers",
      "defaultBindings",
      "sessionBindings",
    ]);
    if (
      parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.providers) ||
      !parsed.sessionBindings ||
      typeof parsed.sessionBindings !== "object"
    )
      throw new Error();
    const settings = parsed as unknown as ProviderSettings;
    if (
      new Set(settings.providers.map((p) => p.id)).size !==
      settings.providers.length
    )
      throw new Error();
    for (const p of settings.providers) {
      onlyKeys(p, [
        "id",
        "name",
        "protocol",
        "baseURL",
        "authentication",
        "credentialRef",
        "allowRemoteHTTP",
        "models",
        "defaults",
        "revision",
      ]);
      text(p.id, "Provider ID");
      text(p.name, "Provider名称");
      if (
        !protocols.has(p.protocol) ||
        !Number.isInteger(p.revision) ||
        p.revision < 1 ||
        !Array.isArray(p.models)
      )
        throw new Error();
      validateProviderURL(p.baseURL, p.allowRemoteHTTP);
      if (
        typeof p.allowRemoteHTTP !== "boolean" ||
        !["none", "api-key"].includes(p.authentication)
      )
        throw new Error();
      if (p.credentialRef !== null) secretPath(p.credentialRef);
      onlyKeys(p.defaults, [
        "model",
        "timeoutMs",
        "maxOutputTokens",
        "temperature",
      ]);
      text(p.defaults.model, "默认模型");
      if (
        !Number.isInteger(p.defaults.timeoutMs) ||
        p.defaults.timeoutMs < 1000 ||
        p.defaults.timeoutMs > 600000
      )
        throw new Error();
      for (const m of p.models) {
        onlyKeys(m, ["id", "alias", "source", "capabilities", "validation"]);
        text(m.id, "模型 ID");
        if (m.alias !== undefined) text(m.alias, "别名");
        if (!["manual", "discovered"].includes(m.source)) throw new Error();
        onlyKeys(m.capabilities, ["streaming", "tools", "images", "reasoning"]);
        if (
          ["streaming", "tools", "images", "reasoning"].some(
            (key) =>
              !["unknown", "supported", "unsupported"].includes(
                object(m.capabilities)[key] as string,
              ),
          )
        )
          throw new Error();
        onlyKeys(m.validation, [
          "state",
          "protocol",
          "providerRevision",
          "checkedAt",
          "diagnostic",
        ]);
        if (
          ![
            "unverified",
            "text-available",
            "tools-available",
            "failed",
          ].includes(m.validation.state) ||
          !protocols.has(m.validation.protocol) ||
          !Number.isInteger(m.validation.providerRevision) ||
          m.validation.providerRevision < 1 ||
          m.validation.providerRevision > p.revision
        )
          throw new Error();
      }
      if (!p.models.some((m) => m.id === p.defaults.model)) throw new Error();
    }
    const checkBindings = (b: RoleBindings) => {
      onlyKeys(b, ["persona", "executor"]);
      for (const binding of [b.persona, b.executor]) {
        onlyKeys(binding, ["providerId", "modelId", "reasoningEffort"]);
        if (binding.reasoningEffort !== undefined) {
          const provider = settings.providers.find(
            (p) => p.id === binding.providerId,
          );
          if (
            !provider ||
            !reasoningChoices(provider, binding.modelId).includes(
              binding.reasoningEffort,
            )
          )
            throw new Error();
        }
        if (
          !settings.providers.some(
            (p) =>
              p.id === binding.providerId &&
              p.models.some((m) => m.id === binding.modelId),
          )
        )
          throw new Error();
      }
    };
    if (settings.defaultBindings !== null)
      checkBindings(settings.defaultBindings);
    for (const [id, bindings] of Object.entries(settings.sessionBindings)) {
      text(id, "会话 ID");
      if (["__proto__", "prototype", "constructor"].includes(id))
        throw new Error();
      checkBindings(bindings);
    }
    return settings;
  } catch {
    throw new Error(
      "Provider 配置文件损坏或版本不支持；原文件已保留，请备份后修复。",
    );
  }
}
function status(provider: ProviderConfig) {
  if (!provider.credentialRef) return { set: false, encrypted: false };
  try {
    const key = safeStorage.decryptString(
      readFileSync(secretPath(provider.credentialRef)),
    );
    return { set: !!key, encrypted: protects() };
  } catch {
    return { set: false, encrypted: false };
  }
}
function view(settings: ProviderSettings): ProviderSettingsView {
  return {
    settings,
    credentialStatuses: Object.fromEntries(
      settings.providers.map((p) => [p.id, status(p)]),
    ),
    runtimeActive: true,
  };
}
export function getProviderSettings(): ProviderSettingsView {
  return view(load());
}
function persist(settings: ProviderSettings): ProviderSettingsView {
  atomicWrite(configPath(), `${JSON.stringify(settings, null, 2)}\n`);
  return view(settings);
}
export function saveProvider(
  input: SaveProviderInput,
  migrationBindings?: { personaModelId: string; executorModelId: string },
): ProviderSettingsView {
  const raw = object(input);
  const name = text(raw.name, "Provider 名称");
  const settings = load();
  const id = raw.id === undefined ? randomUUID() : text(raw.id, "Provider ID");
  const old = settings.providers.find((p) => p.id === id);
  if (raw.id !== undefined && !old) throw new Error("Provider 不存在。");
  if (old && raw.expectedRevision !== old.revision)
    throw new Error("配置已更新，请重新加载后编辑。");
  const protocol = text(raw.protocol, "协议") as ProviderProtocol;
  if (!protocols.has(protocol)) throw new Error("Provider 协议不受支持。");
  if (
    !["api-key", "none"].includes(String(raw.authentication)) ||
    typeof raw.allowRemoteHTTP !== "boolean"
  )
    throw new Error("鉴权或 HTTP 选项无效。");
  const baseURL = validateProviderURL(raw.baseURL, raw.allowRemoteHTTP);
  if (
    raw.authentication === "none" &&
    ["api.openai.com", "api.anthropic.com"].includes(new URL(baseURL).hostname)
  )
    throw new Error("官方 API 必须使用 API Key 鉴权。");
  const defaults = object(raw.defaults);
  const model = text(defaults.model, "默认模型");
  const timeoutMs = defaults.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 600000
  )
    throw new Error("超时需为 1000–600000 毫秒。");
  if (
    defaults.maxOutputTokens !== undefined &&
    (typeof defaults.maxOutputTokens !== "number" ||
      !Number.isInteger(defaults.maxOutputTokens) ||
      defaults.maxOutputTokens < 1 ||
      defaults.maxOutputTokens > 1000000)
  )
    throw new Error("输出 token 上限无效。");
  if (
    defaults.temperature !== undefined &&
    (typeof defaults.temperature !== "number" ||
      !Number.isFinite(defaults.temperature) ||
      defaults.temperature < 0 ||
      defaults.temperature > 2)
  )
    throw new Error("温度需为 0–2。");
  if (
    !Array.isArray(raw.models) ||
    raw.models.length < 1 ||
    raw.models.length > 500
  )
    throw new Error("请至少手填一个模型，最多 500 个。");
  const revision = (old?.revision ?? 0) + 1;
  const models = raw.models.map((item) => {
    const m = object(item);
    const previous = old?.models.find((entry) => entry.id === m.id);
    const previousSuccessful =
      previous &&
      (["text-available", "tools-available"].includes(
        previous.validation.state,
      ) ||
        previous.validation.providerRevision < (old?.revision ?? revision));
    return {
      id: text(m.id, "模型 ID"),
      ...(m.alias === undefined || m.alias === ""
        ? {}
        : { alias: text(m.alias, "模型别名") }),
      source: "manual" as const,
      capabilities: {
        streaming: "unknown" as const,
        tools: "unknown" as const,
        images: "unknown" as const,
        reasoning: "unknown" as const,
      },
      validation: {
        state: "unverified" as const,
        protocol: previousSuccessful ? previous.validation.protocol : protocol,
        providerRevision: previousSuccessful
          ? previous.validation.providerRevision
          : revision,
      },
    };
  });
  if (
    new Set(models.map((m) => m.id)).size !== models.length ||
    !models.some((m) => m.id === model)
  )
    throw new Error("模型 ID 不得重复，默认模型必须在列表中。");
  const credential = object(raw.credential);
  if (!["keep", "replace", "clear"].includes(String(credential.action)))
    throw new Error("凭据操作无效。");
  let credentialRef = old?.credentialRef ?? null;
  let newRef: string | null = null;
  if (raw.authentication === "none" || credential.action === "clear")
    credentialRef = null;
  else if (credential.action === "replace") {
    const key = text(credential.value, "API Key", 8192);
    if (!protects())
      throw new Error("系统安全存储不可用，未保存；原配置与凭据保持不变。");
    const encrypted = safeStorage.encryptString(key);
    newRef = `provider-${randomUUID()}`;
    mkdirSync(join(root(), "provider-credentials"), { recursive: true });
    atomicWrite(secretPath(newRef), encrypted);
    credentialRef = newRef;
  }
  const provider: ProviderConfig = {
    id,
    name,
    protocol,
    baseURL,
    authentication: raw.authentication as "api-key" | "none",
    credentialRef,
    allowRemoteHTTP: raw.allowRemoteHTTP as boolean,
    models,
    defaults: {
      model,
      timeoutMs,
      ...(defaults.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: defaults.maxOutputTokens as number }),
      ...(defaults.temperature === undefined
        ? {}
        : { temperature: defaults.temperature as number }),
    },
    revision,
  };
  try {
    const next = {
      ...settings,
      providers: [...settings.providers.filter((p) => p.id !== id), provider],
      ...(migrationBindings
        ? {
            defaultBindings: {
              persona: {
                providerId: id,
                modelId: migrationBindings.personaModelId,
              },
              executor: {
                providerId: id,
                modelId: migrationBindings.executorModelId,
              },
            },
          }
        : {}),
    };
    // A removed model cannot retain a binding that points to it.
    const valid = (bindings: RoleBindings | null) =>
      !bindings ||
      [bindings.persona, bindings.executor].every(
        (b) =>
          b.providerId !== id ||
          (models.some((m) => m.id === b.modelId) &&
            (!b.reasoningEffort ||
              reasoningChoices(provider, b.modelId).includes(
                b.reasoningEffort,
              ))),
      );
    if (
      !valid(next.defaultBindings) ||
      Object.values(next.sessionBindings).some((b) => !valid(b))
    )
      throw new Error("模型正在被绑定，请先调整模型绑定或思考强度后修改配置。");
    const result = persist(next);
    if (old?.credentialRef && old.credentialRef !== credentialRef) {
      try {
        rmSync(secretPath(old.credentialRef), { force: true });
      } catch {
        /* stale encrypted orphan, never used */
      }
    }
    return result;
  } catch (error) {
    if (newRef) rmSync(secretPath(newRef), { force: true });
    throw error;
  }
}
export function deleteProvider(idValue: string): ProviderSettingsView {
  const id = text(idValue, "Provider ID");
  const settings = load();
  const old = settings.providers.find((p) => p.id === id);
  if (!old) throw new Error("Provider 不存在。");
  if (activeProviders.has(id))
    throw new Error("Provider 正被运行中的轮次使用，请先停止后删除。");
  const uses = (b: RoleBindings) =>
    b.persona.providerId === id || b.executor.providerId === id;
  const result = persist({
    ...settings,
    providers: settings.providers.filter((p) => p.id !== id),
    defaultBindings:
      settings.defaultBindings && uses(settings.defaultBindings)
        ? null
        : settings.defaultBindings,
    sessionBindings: Object.fromEntries(
      Object.entries(settings.sessionBindings).filter(([, b]) => !uses(b)),
    ),
  });
  if (old.credentialRef) {
    try {
      rmSync(secretPath(old.credentialRef), { force: true });
    } catch {
      /* stale encrypted orphan */
    }
  }
  return result;
}
export function setProviderBindings(
  input: SetProviderBindingsInput,
): ProviderSettingsView {
  const raw = object(input);
  const settings = load();
  const validate = (value: unknown): RoleBindings | null => {
    if (value === null) return null;
    const b = object(value);
    const binding = (value: unknown) => {
      const item = object(value);
      const providerId = text(item.providerId, "Provider ID");
      const modelId = text(item.modelId, "模型 ID");
      if (
        !settings.providers.some(
          (p) => p.id === providerId && p.models.some((m) => m.id === modelId),
        )
      )
        throw new Error("绑定的 Provider 或模型不存在。");
      const provider = settings.providers.find((p) => p.id === providerId)!;
      const effort = item.reasoningEffort;
      if (
        effort !== undefined &&
        (typeof effort !== "string" ||
          !reasoningChoices(provider, modelId).includes(effort))
      )
        throw new Error("该模型不支持所选思考强度。");
      return {
        providerId,
        modelId,
        ...(typeof effort === "string" ? { reasoningEffort: effort } : {}),
      };
    };
    return { persona: binding(b.persona), executor: binding(b.executor) };
  };
  const bindings = validate(raw.bindings);
  if (raw.sessionId === undefined || raw.sessionId === null)
    return persist({ ...settings, defaultBindings: bindings });
  const id = text(raw.sessionId, "会话 ID");
  if (["__proto__", "prototype", "constructor"].includes(id))
    throw new Error("会话 ID 无效。");
  const sessionBindings = { ...settings.sessionBindings };
  if (bindings) sessionBindings[id] = bindings;
  else delete sessionBindings[id];
  return persist({ ...settings, sessionBindings });
}
/** Main only: never expose this return value through IPC. */
export function resolveProviderCredential(
  provider: ProviderConfig,
): string | null {
  if (provider.authentication === "none") return null;
  if (!provider.credentialRef || !protects())
    throw new Error("Provider 缺少可读取的安全凭据。");
  try {
    const key = safeStorage
      .decryptString(readFileSync(secretPath(provider.credentialRef)))
      .trim();
    if (!key) throw new Error();
    return key;
  } catch {
    throw new Error("Provider 凭据不可读取，请重新配置 API Key。");
  }
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
export function getProviderReadiness(sessionId?: string): ProviderReadiness {
  if (sessionId !== undefined) text(sessionId, "会话 ID");
  const base = {
    sessionId: sessionId ?? null,
    scope: "global" as "global" | "session",
  };
  let settings: ProviderSettings;
  try {
    settings = load();
  } catch {
    return {
      ...base,
      ready: false,
      issue: {
        code: "settings-unreadable",
        message: "连接配置无法读取。请打开设置检查；原文件保留。",
        action: "configure",
      },
    };
  }
  const override =
    sessionId && Object.hasOwn(settings.sessionBindings, sessionId)
      ? settings.sessionBindings[sessionId]
      : undefined;
  if (override) base.scope = "session";
  const bindings = override ?? settings.defaultBindings;
  if (!bindings)
    return {
      ...base,
      ready: false,
      issue: {
        code: "no-binding",
        message:
          "尚未选择对话与执行模型。请完成模型验证并设为默认，或用于当前任务。",
        action: "configure",
      },
    };
  for (const role of ["persona", "executor"] as const) {
    const binding = bindings[role];
    const provider = settings.providers.find(
      (p) => p.id === binding.providerId,
    );
    const model = provider?.models.find((m) => m.id === binding.modelId);
    const fail = (
      code: NonNullable<ProviderReadiness["issue"]>["code"],
      message: string,
      action: "configure" | "credential" | "validate",
    ): ProviderReadiness => ({
      ...base,
      bindings,
      ready: false,
      issue: { code, message, action, role },
    });
    if (!provider || !model)
      return fail(
        "missing-model",
        "任务绑定的连接或模型已不存在，请重新选择。",
        "configure",
      );
    if (provider.authentication !== "none") {
      if (!provider.credentialRef)
        return fail(
          "missing-credential",
          "所选连接尚未保存 API Key。",
          "credential",
        );
      try {
        resolveProviderCredential(provider);
      } catch {
        return fail(
          "credential-unavailable",
          "所选连接的安全凭据无法读取，请在本机重新保存 API Key。",
          "credential",
        );
      }
    }
    if (
      model.validation.providerRevision !== provider.revision ||
      model.validation.protocol !== provider.protocol
    )
      return fail(
        "validation-expired",
        "连接配置已经改变，请重新验证当前模型。",
        "validate",
      );
    if (!["text-available", "tools-available"].includes(model.validation.state))
      return fail(
        "model-unverified",
        `${role === "persona" ? "对话" : "执行"}模型尚未验证成功，请完成模型验证。`,
        "validate",
      );
    if (
      role === "executor" &&
      (model.validation.state !== "tools-available" ||
        model.capabilities.tools !== "supported")
    )
      return fail(
        "tools-unavailable",
        "执行模型尚未通过当前配置的工具能力验证。",
        "validate",
      );
  }
  return { ...base, bindings, ready: true };
}
export class ProviderConfigurationError extends Error {
  readonly readiness: ProviderReadiness;
  constructor(readiness: ProviderReadiness) {
    super(readiness.issue?.message ?? "连接尚未就绪。");
    this.name = "ProviderConfigurationError";
    this.readiness = readiness;
  }
}
export function acquireTurnProviders(
  sessionId: string,
  turnId: string,
): {
  snapshot: TurnProviderSnapshot;
  personaKey: string | null;
  executorKey: string | null;
  release: () => void;
} {
  text(sessionId, "会话 ID");
  text(turnId, "轮次 ID");
  const readiness = getProviderReadiness(sessionId);
  if (!readiness.ready) throw new ProviderConfigurationError(readiness);
  const settings = load();
  const bindings =
    (Object.hasOwn(settings.sessionBindings, sessionId)
      ? settings.sessionBindings[sessionId]
      : undefined) ?? settings.defaultBindings;
  if (!bindings) throw new Error("请先为黑塔和执行器选择 Provider 与模型。");
  const resolve = (binding: ModelBinding) => {
    const provider = settings.providers.find(
      (p) => p.id === binding.providerId,
    );
    if (!provider?.models.some((m) => m.id === binding.modelId))
      throw new Error("绑定的 Provider 或模型不存在。");
    return provider;
  };
  const persona = resolve(bindings.persona),
    executor = resolve(bindings.executor);
  const executionModel = executor.models.find(
    (m) => m.id === bindings.executor.modelId,
  );
  if (
    !executionModel ||
    executionModel.validation.state !== "tools-available" ||
    executionModel.validation.providerRevision !== executor.revision ||
    executionModel.capabilities.tools !== "supported"
  )
    throw new Error("执行模型尚未通过当前配置的工具能力验证。");
  const personaKey = resolveProviderCredential(persona),
    executorKey = resolveProviderCredential(executor);
  const snapshot = deepFreeze(
    JSON.parse(
      JSON.stringify({ sessionId, turnId, bindings, persona, executor }),
    ) as TurnProviderSnapshot,
  );
  const ids = [...new Set([persona.id, executor.id])];
  for (const id of ids)
    activeProviders.set(id, (activeProviders.get(id) ?? 0) + 1);
  let released = false;
  return {
    snapshot,
    personaKey,
    executorKey,
    release: () => {
      if (released) return;
      released = true;
      for (const id of ids) {
        const count = (activeProviders.get(id) ?? 1) - 1;
        if (count) activeProviders.set(id, count);
        else activeProviders.delete(id);
      }
    },
  };
}
/** Probe results apply to the tested revision, never overwrite concurrent edits. */
export function updateProviderModels(
  providerId: string,
  revision: number,
  update: (models: readonly ProviderModel[]) => readonly ProviderModel[],
): ProviderSettingsView {
  const settings = load();
  const provider = settings.providers.find((p) => p.id === providerId);
  if (!provider || provider.revision !== revision)
    throw new Error("验证期间配置已改变，请重新验证。");
  const updated = { ...provider, models: update(provider.models) };
  return persist({
    ...settings,
    providers: settings.providers.map((p) =>
      p.id === providerId ? updated : p,
    ),
  });
}
/** Migration rollback restores only its own just-created provider/config. Main only. */
export function restoreProviderSettingsForMigration(
  settings: ProviderSettings,
  createdRef: string | null,
): void {
  persist(settings);
  if (createdRef) rmSync(secretPath(createdRef), { force: true });
}

/** Chat requires only a validated text model; it never resolves an executor. */
export function acquireChatProvider(providerId: string, modelId: string) {
  const provider = load().providers.find((p) => p.id === providerId);
  const model = provider?.models.find((m) => m.id === modelId);
  if (
    !provider ||
    !model ||
    !["text-available", "tools-available"].includes(model.validation.state) ||
    model.validation.providerRevision !== provider.revision ||
    model.validation.protocol !== provider.protocol
  )
    throw new Error("请先在连接设置中验证所选模型的文本能力。");
  const key = resolveProviderCredential(provider);
  const config = structuredClone(provider);
  activeProviders.set(provider.id, (activeProviders.get(provider.id) ?? 0) + 1);
  let released = false;
  return {
    config,
    key,
    release: () => {
      if (released) return;
      released = true;
      const count = (activeProviders.get(provider.id) ?? 1) - 1;
      if (count) activeProviders.set(provider.id, count);
      else activeProviders.delete(provider.id);
    },
  };
}
