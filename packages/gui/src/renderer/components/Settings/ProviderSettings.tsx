import { providerPresets } from "../../../shared/provider-presets.js";
import type {
  ModelBinding,
  ProviderConfig,
  ProviderModel,
  ProviderProtocol,
  RoleBindings,
} from "@herta/providers";
import { useCallback, useEffect, useId, useState } from "react";
import type {
  ImageCheckView,
  ProviderSettingsView,
  SaveProviderInput,
  ValidateProviderModelResult,
} from "../../../shared/provider-settings-ipc.js";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import "./provider-settings.css";

export interface ProviderEditorControl {
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly save: () => Promise<boolean>;
}
interface Props {
  readonly sessionId?: string;
  readonly onControl: (control: ProviderEditorControl) => void;
  readonly onDone?: () => void;
}
interface Draft {
  presetId?: string;
  timeoutMs: number;
  id?: string;
  expectedRevision?: number;
  name: string;
  protocol: ProviderProtocol;
  baseURL: string;
  authentication: "api-key" | "none";
  allowRemoteHTTP: boolean;
  models: { id: string; alias?: string }[];
  defaultModel: string;
  credentialAction: "keep" | "clear" | "replace";
  key: string;
}
const protocols: Record<ProviderProtocol, string> = {
  "openai-responses": "OpenAI Responses",
  "openai-chat-completions": "OpenAI Chat Completions",
  "anthropic-messages": "Anthropic Messages",
};
const validationLabels = {
  unverified: "未验证",
  "text-available": "文本可用",
  "tools-available": "工具可用",
  failed: "验证失败",
};
/** Only a passed or failed image probe is worth a word; untested says nothing. */
const imageLabels = {
  unknown: "",
  supported: " · 识图通过",
  unsupported: " · 识图未通过",
};
/** F06 (R104): a result saved for an earlier connection is not shown as current, and an old pass
 *  carries a reminder; nothing re-probes on its own. */
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const statusLabel = (p: ProviderConfig, m: ProviderModel, now = Date.now()): string => {
  if (m.validation.providerRevision !== p.revision || m.validation.protocol !== p.protocol)
    return "需重新验证（连接已修改）";
  const passed = ["text-available", "tools-available"].includes(m.validation.state);
  const checked = m.validation.checkedAt ? Date.parse(m.validation.checkedAt) : Number.NaN;
  return `${validationLabels[m.validation.state]}${passed && now - checked > STALE_AFTER_MS ? "（已超过30天，建议重新验证）" : ""}`;
};
/** F06 (R109): image results are dated too, beside the settings (provider-image-checks.ts). An old
 *  pass gets the same reminder, and a result a connection change reset says so instead of nothing.
 *  A result saved before R109 has no date, so no reminder. */
const imageCheckFor = (
  view: ProviderSettingsView | null,
  p: ProviderConfig,
  m: ProviderModel,
): ImageCheckView | undefined =>
  view?.imageChecks?.find((c) => c.providerId === p.id && c.modelId === m.id);
const imageLabel = (m: ProviderModel, check: ImageCheckView | undefined, now = Date.now()): string => {
  // R110: a request with pictures was refused since the last check. The result was not changed,
  // so it is still named; the next conclusive check clears the mark.
  if (check?.review)
    return m.capabilities.images === "unknown" ? " · 识图待复核" : `${imageLabels[m.capabilities.images]}（待复核）`;
  if (m.capabilities.images === "unknown")
    return check?.connectionChanged ? " · 识图需重新测试（连接已修改）" : "";
  const checked = check?.checkedAt ? Date.parse(check.checkedAt) : Number.NaN;
  return `${imageLabels[m.capabilities.images]}${m.capabilities.images === "supported" && now - checked > STALE_AFTER_MS ? "（已超过30天，建议重新测试识图）" : ""}`;
};
const refusalSurfaces = { chat: "黑塔聊天", workbench: "工作台" } as const;
const checkedTitle = (m: ProviderModel, check?: ImageCheckView): string | undefined => {
  const lines = [
    m.validation.checkedAt && !Number.isNaN(Date.parse(m.validation.checkedAt))
      ? `上次验证：${new Date(m.validation.checkedAt).toLocaleString()}`
      : "",
    check?.checkedAt ? `识图检测：${new Date(check.checkedAt).toLocaleString()}` : "",
    check?.review
      ? `识图待复核：${new Date(check.review.at).toLocaleString()}，${refusalSurfaces[check.review.surface]}中附带图片的请求被服务拒绝（HTTP ${check.review.status}）。原因未确认，识图结果未自动更改；重新测试识图后清除。`
      : "",
  ].filter(Boolean);
  return lines.length ? lines.join("\n") : undefined;
};
/** F06 (R104): the words for a probe that saved nothing. */
const unsavedNotice = (result: ValidateProviderModelResult): string | null =>
  result.superseded
    ? "已有更新的验证在进行，本次结果未采用。"
    : result.kept
      ? `验证未完成：${result.kept.diagnostic}已有验证结果保留，可稍后重试。`
      : null;
/** Describe the saved effective binding, never the unsaved advanced-editor selection. */
function currentBinding(
  view: ProviderSettingsView,
  binding: ModelBinding,
  role: "persona" | "executor",
) {
  const provider = view.settings.providers.find(
    (p) => p.id === binding.providerId,
  );
  const model = provider?.models.find((m) => m.id === binding.modelId);
  if (!provider)
    return { label: binding.modelId, status: "连接不存在", ready: false };
  if (!model)
    return {
      label: `${binding.modelId} · ${provider.name}`,
      status: "模型已不在连接中",
      ready: false,
    };
  const current =
    model.validation.providerRevision === provider.revision &&
    model.validation.protocol === provider.protocol;
  const validated =
    current &&
    (role === "executor"
      ? model.validation.state === "tools-available" &&
        model.capabilities.tools === "supported"
      : ["text-available", "tools-available"].includes(model.validation.state));
  const credential =
    provider.authentication === "none" ||
    view.credentialStatuses[provider.id]?.set === true;
  const status =
    current &&
    role === "executor" &&
    model.validation.state === "text-available"
      ? "文本可用，需验证工具"
      : current &&
          role === "executor" &&
          model.validation.state === "tools-available" &&
          model.capabilities.tools !== "supported"
        ? "工具能力需重新验证"
        : statusLabel(provider, model);
  return {
    label: `${model.alias || model.id} · ${provider.name}`,
    status: credential ? status : `${status} · 缺少 API Key`,
    ready: validated && credential,
    title: checkedTitle(model, imageCheckFor(view, provider, model)),
  };
}
const fresh = (): Draft => ({
  timeoutMs: 60000,
  name: "",
  protocol: "openai-responses",
  baseURL: "https://api.openai.com/v1",
  authentication: "api-key",
  allowRemoteHTTP: false,
  models: [],
  defaultModel: "",
  credentialAction: "keep",
  key: "",
});
const fromProvider = (p: ProviderConfig): Draft => ({
  timeoutMs: p.defaults.timeoutMs,
  id: p.id,
  expectedRevision: p.revision,
  name: p.name,
  protocol: p.protocol,
  baseURL: p.baseURL,
  authentication: p.authentication,
  allowRemoteHTTP: p.allowRemoteHTTP,
  models: p.models.map((m) => ({
    id: m.id,
    ...(m.alias ? { alias: m.alias } : {}),
  })),
  defaultModel: p.defaults.model,
  credentialAction: "keep",
  key: "",
});

// Never display arbitrary bridge errors: they can include request bodies or secrets.
export function ProviderSettings({
  sessionId,
  onControl,
  onDone,
}: Props): JSX.Element {
  const { bridge } = useHertaBridge();
  const [view, setView] = useState<ProviderSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [failedLoad, setFailedLoad] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showAntigravity, setShowAntigravity] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [validationUse, setValidationUse] = useState<"text" | "tools">("tools");
  const [pending, setPending] = useState<Draft | null>(null);
  const [modelId, setModelId] = useState("");
  const [modelAlias, setModelAlias] = useState("");
  const [scope, setScope] = useState<"global" | "session">("global");
  const [bindings, setBindings] = useState<RoleBindings | null>(null);
  const [bindingsDirty, setBindingsDirty] = useState(false);
  const [separate, setSeparate] = useState(false);
  const [setupChoice, setSetupChoice] = useState("");
  const [setupComplete, setSetupComplete] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const setupId = useId();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setFailedLoad(false);
    try {
      setView(await bridge.getProviderSettings());
    } catch {
      setFailedLoad(true);
    } finally {
      setLoading(false);
    }
  }, [bridge]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const next =
      scope === "session" && sessionId
        ? (view?.settings.sessionBindings[sessionId] ?? null)
        : (view?.settings.defaultBindings ?? null);
    setBindings(next);
    setBindingsDirty(false);
    setSeparate(
      Boolean(
        next &&
          (next.persona.providerId !== next.executor.providerId ||
            next.persona.modelId !== next.executor.modelId),
      ),
    );
  }, [view, scope, sessionId]);
  // The guided choice starts on the model actually in use — this task's own
  // binding, else the global one — when chat and coding share it, so a set-up
  // app no longer reads as "nothing chosen" (R68). Never overrides a choice.
  useEffect(() => {
    const inUse =
      (sessionId ? view?.settings.sessionBindings[sessionId] : undefined) ??
      view?.settings.defaultBindings;
    if (
      !inUse ||
      inUse.persona.providerId !== inUse.executor.providerId ||
      inUse.persona.modelId !== inUse.executor.modelId ||
      !view?.settings.providers.some(
        (p) =>
          p.id === inUse.persona.providerId &&
          p.models.some((m) => m.id === inUse.persona.modelId),
      )
    )
      return;
    setSetupChoice(
      (current) =>
        current ||
        JSON.stringify([inUse.persona.providerId, inUse.persona.modelId]),
    );
  }, [view, sessionId]);
  const patch = (changes: Partial<Draft>): void => {
    setDraft((d) => (d ? { ...d, ...changes } : d));
    setDirty(true);
    setError("");
    setNotice("");
  };
  const save = useCallback(
    async (fetchModels = false, verify?: "text" | "tools"): Promise<boolean> => {
      if (!draft || busy) return !dirty;
      if (modelId.trim() || modelAlias.trim()) {
        setError("请先添加模型，或清空尚未添加的模型输入，再保存连接。");
        return false;
      }
      if (
        !draft.name.trim() ||
        !draft.baseURL.trim() ||
        !draft.models.length ||
        !draft.defaultModel
      ) {
        setError("请填写名称、API 根地址，添加模型并选择默认模型。");
        return false;
      }
      if (
        !Number.isInteger(draft.timeoutMs) ||
        draft.timeoutMs < 1000 ||
        draft.timeoutMs > 600000
      ) {
        setError("请求超时需为 1 至 600 秒。");
        return false;
      }
      if (draft.credentialAction === "replace" && !draft.key.trim()) {
        setError("替换凭据时请输入 API Key，或选择保留已有凭据。");
        return false;
      }
      setBusy(true);
      setError("");
      setNotice("");
      const old = view?.settings.providers.find((p) => p.id === draft.id);
      const input: SaveProviderInput = {
        ...(draft.id
          ? { id: draft.id, expectedRevision: draft.expectedRevision }
          : {}),
        name: draft.name.trim(),
        protocol: draft.protocol,
        baseURL: draft.baseURL.trim(),
        authentication: draft.authentication,
        allowRemoteHTTP: draft.allowRemoteHTTP,
        models: draft.models,
        defaults: {
          ...(old?.defaults ?? {}),
          timeoutMs: draft.timeoutMs,
          model: draft.defaultModel,
        },
        credential:
          draft.authentication === "none" || draft.credentialAction === "clear"
            ? { action: "clear" }
            : draft.credentialAction === "replace"
              ? { action: "replace", value: draft.key }
              : { action: "keep" },
      };
      try {
        const next = await bridge.saveProvider(input);
        setView(next);
        setDraft(null);
        setDirty(false);
        const saved =
          next.settings.providers.find((p) => p.id === draft.id) ??
          next.settings.providers.find(
            (p) =>
              p.name === input.name &&
              !view?.settings.providers.some(old => old.id === p.id) &&
              p.protocol === input.protocol,
          );
        if (saved)
          setSetupChoice(JSON.stringify([saved.id, saved.defaults.model]));
        setSetupComplete(false);
        setShowSetup(true);
        setNotice(
          "连接已保存。下一步：选择模型并验证。",
        );
        if (verify && saved) {
          setNotice("连接已保存，正在验证所选模型…");
          let unsaved: string | null = null;
          try {
            for (const kind of (verify === "tools" ? ["text", "tools"] : ["text"]) as ("text" | "tools")[]) {
              // A save that kept the connection keeps the model's results (R83): nothing to resend.
              const kept = saved.models.find(m => m.id === saved.defaults.model);
              if (kept && kept.validation.providerRevision === saved.revision && kept.validation.protocol === saved.protocol &&
                (kind === "tools" ? kept.validation.state === "tools-available" && kept.capabilities.tools === "supported" : ["text-available", "tools-available"].includes(kept.validation.state)))
                continue;
              const result = await bridge.validateProviderModel({ providerId: saved.id, modelId: saved.defaults.model, expectedRevision: saved.revision, kind });
              setView(result.view);
              unsaved = unsavedNotice(result);
              if (unsaved) throw new Error("Validation not saved");
              const current = result.view.settings.providers.find(p => p.id === saved.id);
              const model = current?.models.find(m => m.id === saved.defaults.model);
              const valid = current?.revision === saved.revision && model?.validation.providerRevision === saved.revision && model.validation.protocol === saved.protocol &&
                (kind === "tools" ? model.validation.state === "tools-available" && model.capabilities.tools === "supported" : ["text-available", "tools-available"].includes(model.validation.state));
              if (!valid) throw new Error("Validation not current or unsuccessful");
            }
            setNotice(verify === "tools" ? "已保存并通过文本与工具验证。可直接选择应用范围，无需再次验证。" : "已保存并通过聊天验证，可在聊天模型列表中选择。编程用途仍需工具验证。");
          } catch {
            setDraft(fromProvider(saved));
            setNotice("");
            setError(unsaved ? `连接已保存。${unsaved}` : "连接已保存，但模型验证未完成或配置已变化。请检查后重试；原有绑定未更改。");
            return false;
          }
        }
        if (fetchModels && saved) {
          try {
            const result = await bridge.discoverProviderModels({
              providerId: saved.id,
              expectedRevision: saved.revision,
              refresh: true,
            });
            setView(result.view);
            const current = result.view.settings.providers.find(
              (p) => p.id === saved.id,
            );
            if (current)
              setDraft({
                ...fromProvider(current),
                ...(draft.presetId ? { presetId: draft.presetId } : {}),
              });
            setNotice(
              result.diagnostic ||
                `已保存连接并获取 ${result.models.length} 个模型，请选择默认模型后保存。`,
            );
          } catch {
            setNotice(
              "连接已保存，但获取模型失败。仍可选择预设模型或手动添加，再验证是否可用。",
            );
            setDraft({
              ...fromProvider(saved),
              ...(draft.presetId ? { presetId: draft.presetId } : {}),
            });
          }
        }
        return true;
      } catch {
        setError(
          "保存失败：请检查 API 根地址、模型和系统加密状态后重试。原配置已保留。",
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [draft, busy, dirty, bridge, view, modelId, modelAlias],
  );
  const choosePreset = (id: string): void => {
    const preset = providerPresets.find((p) => p.id === id);
    setShowAntigravity(id === "antigravity");
    setModelId("");
    setModelAlias("");
    setDraft(
      preset
        ? {
            ...fresh(),
            presetId: preset.id,
            name: preset.name,
            protocol: preset.protocol,
            baseURL: preset.baseURL,
            models: preset.models.map((id) => ({ id })),
            defaultModel: preset.models[0] ?? "",
            credentialAction: "replace",
            timeoutMs: 120000,
          }
        : fresh(),
    );
    setDirty(Boolean(preset));
    setError("");
    setNotice("");
  };
  const select = (next: Draft): void => {
    setShowAntigravity(false);
    if (dirty) setPending(next);
    else {
      setDraft(next);
      setError("");
      setModelId("");
      setModelAlias("");
    }
  };
  const addModel = (): void => {
    if (!draft || !modelId.trim()) return;
    const id = modelId.trim();
    if (draft.models.some((m) => m.id === id)) {
      setError("该模型 ID 已在列表中。");
      return;
    }
    patch({
      models: [
        ...draft.models,
        { id, ...(modelAlias.trim() ? { alias: modelAlias.trim() } : {}) },
      ],
      defaultModel: draft.defaultModel || id,
    });
    setModelId("");
    setModelAlias("");
  };
  const encode = (b: ModelBinding | undefined): string =>
    b ? JSON.stringify([b.providerId, b.modelId]) : "";
  const decode = (s: string): ModelBinding => {
    const [providerId, modelId] = JSON.parse(s) as [string, string];
    return { providerId, modelId };
  };
  const bindingSelect = (
    role: "persona" | "executor",
    label: string,
  ): JSX.Element => (
    <label className="provider-field">
      {label}
      <select
        value={encode(bindings?.[role])}
        disabled={busy}
        onChange={(e) => {
          setBindingsDirty(true);
          if (!e.target.value) {
            setBindings(null);
            return;
          }
          const b = decode(e.target.value);
          setBindings((prev) =>
            role === "persona"
              ? { persona: b, executor: separate ? (prev?.executor ?? b) : b }
              : { persona: prev?.persona ?? b, executor: b },
          );
        }}
      >
        <option value="">未选择</option>
        {view?.settings.providers.flatMap((p) =>
          p.models.map((m) => (
            <option
              key={`${p.id}/${m.id}`}
              disabled={m.validation.providerRevision !== p.revision || m.validation.protocol !== p.protocol || (role === "executor" ? m.validation.state !== "tools-available" || m.capabilities.tools !== "supported" : !["text-available", "tools-available"].includes(m.validation.state))}
              value={encode({ providerId: p.id, modelId: m.id })}
            >
              {p.name} / {m.alias || m.id} ·{" "}
              {statusLabel(p, m)}
            </option>
          )),
        )}
      </select>
    </label>
  );
  const saveBindings = useCallback(
    async (clear = false): Promise<boolean> => {
      setBusy(true);
      setError("");
      try {
        setView(
          await bridge.setProviderBindings({
            ...(scope === "session" && sessionId ? { sessionId } : {}),
            bindings: clear ? null : bindings,
          }),
        );
        setBindingsDirty(false);
        setNotice("模型绑定已保存，下一轮生效。");
        return true;
      } catch {
        setError("模型绑定保存失败，原绑定已保留。请重试。");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [bridge, scope, sessionId, bindings],
  );
  const saveAll = useCallback(async (): Promise<boolean> => {
    if (dirty && !(await save())) return false;
    if (bindingsDirty) return saveBindings();
    return true;
  }, [dirty, save, bindingsDirty, saveBindings]);
  const probe = async (kind: "models" | "text" | "tools" | "images"): Promise<void> => {
    const provider = view?.settings.providers.find((p) => p.id === draft?.id);
    if (!provider || dirty || busy) return;
    setBusy(true);
    setError("");
    setNotice("正在向已保存的服务地址发送测试请求…");
    try {
      if (kind === "models") {
        const result = await bridge.discoverProviderModels({
          providerId: provider.id,
          expectedRevision: provider.revision,
          refresh: true,
        });
        setView(result.view);
        const current = result.view.settings.providers.find(
          (p) => p.id === provider.id,
        );
        if (current) setDraft(fromProvider(current));
        setNotice(
          result.diagnostic ||
            `已获取 ${result.models.length} 个模型；列表不代表模型可用。`,
        );
      } else {
        const result = await bridge.validateProviderModel({
          providerId: provider.id,
          modelId: draft?.defaultModel || provider.defaults.model,
          expectedRevision: provider.revision,
          kind,
        });
        setView(result.view);
        setNotice(
          unsavedNotice(result) ??
          (kind === "images"
            ? result.images?.supported
              ? "识图检测通过：附加的图片会发给该模型。"
              : `识图检测未通过：${result.images?.diagnostic ?? "模型没有读出测试图片。"}`
            : `${validationLabels[result.validation.state]}${result.validation.diagnostic ? `：${result.validation.diagnostic}` : ""}`),
        );
      }
    } catch {
      setError(
        "请求失败或配置已变更。请检查服务地址、凭据与模型后重试；也可以手动填写模型。",
      );
      setNotice("");
    } finally {
      setBusy(false);
    }
  };
  /** R109 (F06): the explicit way out of an unreadable record file; main keeps its bytes. */
  const resetImageChecks = async (): Promise<void> => {
    if (!bridge.resetImageChecks || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await bridge.resetImageChecks();
      setView(result.view);
      setNotice(`原记录文件已另存为 ${result.preserved}；之后的识图检测会重新记录时间。`);
    } catch {
      setError("重置识图检测记录失败，原文件保持不变。请重试。");
    } finally {
      setBusy(false);
    }
  };
  const setupBinding = setupChoice ? decode(setupChoice) : null;
  const setupProvider = view?.settings.providers.find(
    (p) => p.id === setupBinding?.providerId,
  );
  const setupModel = setupProvider?.models.find(
    (m) => m.id === setupBinding?.modelId,
  );
  const setupVerified = Boolean(
    setupProvider &&
      setupModel &&
      setupModel.validation.providerRevision === setupProvider.revision &&
      setupModel.validation.state === "tools-available" &&
      setupModel.capabilities.tools === "supported",
  );
  const verifySetup = async (): Promise<void> => {
    if (!setupProvider || !setupBinding || busy || dirty || bindingsDirty)
      return;
    setBusy(true);
    setError("");
    setSetupComplete(false);
    setNotice("正在验证文本与工具能力…");
    try {
      for (const kind of ["text", "tools"] as const) {
        const result = await bridge.validateProviderModel({
          providerId: setupProvider.id,
          modelId: setupBinding.modelId,
          expectedRevision: setupProvider.revision,
          kind,
        });
        setView(result.view);
        const unsaved = unsavedNotice(result);
        if (
          unsaved ||
          result.validation.state === "failed" ||
          (kind === "tools" && result.validation.state !== "tools-available")
        ) {
          setError(
            unsaved ??
              (result.validation.diagnostic ||
                "模型未通过验证，请检查连接和模型。"),
          );
          setNotice("");
          return;
        }
      }
      setNotice(
        "文本与工具验证已完成。请点击下方按钮选择应用范围；尚未自动设为默认。",
      );
    } catch {
      setError(
        "验证未完成或配置已改变，请重新保存并验证。",
      );
      setNotice("");
    } finally {
      setBusy(false);
    }
  };
  const applySetup = async (target: "global" | "session"): Promise<void> => {
    if (
      !setupVerified ||
      !setupBinding ||
      busy ||
      dirty ||
      bindingsDirty ||
      (target === "session" && !sessionId)
    )
      return;
    setBusy(true);
    setShowSetup(true);
    setError("");
    try {
      setView(
        await bridge.setProviderBindings({
          ...(target === "session" ? { sessionId } : {}),
          bindings: { persona: setupBinding, executor: setupBinding },
        }),
      );
      setSetupComplete(true);
      setNotice(
        target === "session"
          ? "当前任务配置已完成，黑塔与执行器共用此模型；下一轮生效。"
          : "全局默认已设置，黑塔与执行器共用此模型；已有任务覆盖不会被修改。",
      );
    } catch {
      setSetupComplete(false);
      setError("应用模型失败。请重新检查验证状态；原绑定保留。");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    onControl({ dirty: dirty || bindingsDirty, busy, save: saveAll });
  }, [dirty, bindingsDirty, busy, saveAll, onControl]);
  if (loading) return <p role="status">正在读取连接配置…</p>;
  if (failedLoad || !view)
    return (
      <div role="alert">
        <p>连接配置读取失败，未覆盖任何已有设置。</p>
        <button type="button" onClick={() => void load()}>
          重试读取
        </button>
      </div>
    );
  const credential = draft?.id ? view.credentialStatuses[draft.id] : undefined;
  const taskBindings = sessionId
    ? view.settings.sessionBindings[sessionId]
    : undefined;
  const effectiveBindings = taskBindings ?? view.settings.defaultBindings;
  const currentModels = effectiveBindings
    ? [
        {
          role: "黑塔",
          ...currentBinding(view, effectiveBindings.persona, "persona"),
        },
        {
          role: "执行",
          ...currentBinding(view, effectiveBindings.executor, "executor"),
        },
      ]
    : [];
  const currentReady =
    currentModels.length === 2 && currentModels.every((model) => model.ready);
  const setupExpanded = !currentReady || showSetup;
  const endpoint = draft
    ? `${draft.baseURL.replace(/\/+$/, "")}/${draft.protocol === "openai-responses" ? "responses" : draft.protocol === "openai-chat-completions" ? "chat/completions" : "messages"}`
    : "";
  return (
    <div className="provider-settings">
      {error && (
        <p className="provider-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {effectiveBindings && (
        <section className="provider-setup" aria-label="工作台模型配置">
          <div className="provider-list-head">
            <h3>{currentReady ? "工作台模型" : "工作台模型需要处理"}</h3>
            {currentReady && (
              <button
                type="button"
                disabled={busy}
                aria-expanded={setupExpanded}
                aria-controls={setupId}
                onClick={() => setShowSetup((value) => !value)}
              >
                {setupExpanded ? "收起调整" : "调整模型"}
              </button>
            )}
          </div>
          <small className="provider-help">
            {taskBindings
              ? "当前任务独立配置"
              : sessionId
                ? "当前任务沿用全局默认"
                : "全局默认"}
          </small>
          {currentModels.map((model) => (
            <div key={model.role} title={model.title}>
              {model.role}：<strong>{model.label}</strong> · {model.status}
            </div>
          ))}
        </section>
      )}
      {setupExpanded && (
        <section
          id={setupId}
          className="provider-setup"
          aria-label={effectiveBindings ? "调整模型配置" : "首次配置引导"}
        >
          <h3>{effectiveBindings ? "调整模型" : "开始使用"}</h3>
          <p className="provider-help">
            {currentReady
              ? "选择模型后应用；黑塔与执行模型也可在高级设置中分别选择。"
              : effectiveBindings
                ? "检查验证状态，修复连接或选择其他模型后再应用。"
                : "添加连接并保存验证，再选择模型的应用范围。"}
          </p>
          <small className="provider-help">独立聊天在消息框选择模型。</small>
          <label className="provider-field">
            用于对话和编程的模型
            <select
              value={setupChoice}
              disabled={busy || dirty || bindingsDirty}
              onChange={(e) => {
                setSetupChoice(e.target.value);
                setSetupComplete(false);
                setNotice("");
              }}
            >
              <option value="">请选择已保存的模型</option>
              {view.settings.providers.flatMap((p) =>
                p.models.map((m) => (
                  <option
                    key={`${p.id}/${m.id}`}
                    value={encode({ providerId: p.id, modelId: m.id })}
                  >
                    {p.name} / {m.alias || m.id} · {statusLabel(p, m)}
                  </option>
                )),
              )}
            </select>
          </label>
          <p className="provider-help">
            “验证模型”会发送小型文本与工具测试请求，可能消耗少量额度。
          </p>
          {setupProvider &&
            setupModel &&
            setupModel.validation.providerRevision !==
              setupProvider.revision && (
              <p>连接已修改，请重新验证当前配置版本。</p>
            )}
          {sessionId && view.settings.sessionBindings[sessionId] && (
            <p className="provider-help">
              当前任务已有独立配置。设置全局默认不会覆盖它，请选择“用于当前任务”，或在高级设置清除覆盖。
            </p>
          )}
          <div className="provider-actions">
            <button
              type="button"
              disabled={!setupBinding || busy || dirty || bindingsDirty}
              onClick={() => void verifySetup()}
            >
              验证模型（文本 + 工具）
            </button>
            <button
              type="button"
              disabled={!setupVerified || busy || dirty || bindingsDirty}
              onClick={() => void applySetup("global")}
            >
              设为全局默认
            </button>
            {sessionId && (
              <button
                type="button"
                disabled={!setupVerified || busy || dirty || bindingsDirty}
                onClick={() => void applySetup("session")}
              >
                用于当前任务
              </button>
            )}
            {setupComplete && onDone && (
              <button type="button" disabled={busy} onClick={onDone}>
                完成，返回任务
              </button>
            )}
          </div>
        </section>
      )}
      <div className="provider-list-head">
        <h3>已保存的连接</h3>
        <button type="button" disabled={busy} onClick={() => select(fresh())}>
          新增连接
        </button>
      </div>
      {!view.settings.providers.length && (
        <p>还没有连接。添加后可以手动填写模型 ID。</p>
      )}
      <ul className="provider-list">
        {view.settings.providers.map((p) => (
          <li key={p.id}>
            <div>
              <strong>{p.name}</strong>
              <small>
                {protocols[p.protocol]} · {p.baseURL}
              </small>
              <small>
                {view.credentialStatuses[p.id]?.set
                  ? "凭据已保存"
                  : p.authentication === "none"
                    ? "无需 API Key"
                    : "未设置凭据"}{" "}
                ·{" "}
                {p.models
                  .map(
                    (m) =>
                      `${m.alias || m.id}：${statusLabel(p, m)}${imageLabel(m, imageCheckFor(view, p, m))}`,
                  )
                  .join(" / ")}
              </small>
            </div>
            <button
              type="button"
              disabled={busy}
              aria-label={`编辑 ${p.name}`}
              onClick={() => select(fromProvider(p))}
            >
              编辑
            </button>
            <button
              type="button"
              disabled={busy || dirty}
              aria-label={`删除 ${p.name}`}
              onClick={() => setDeleteId(p.id)}
            >
              删除
            </button>
          </li>
        ))}
      </ul>
      {view.imageCheckIssue === "unreadable" && (
        <div className="provider-confirm">
          <p>
            识图检测记录文件无法读取，原文件已保留。识图结果仍按已保存的配置生效，只是暂不显示检测时间，新的检测时间也不会记录。
          </p>
          {bridge.resetImageChecks && (
            <button type="button" disabled={busy} onClick={() => void resetImageChecks()}>
              另存原文件并重新记录
            </button>
          )}
        </div>
      )}
      {deleteId && (
        <div className="provider-confirm" role="alert">
          <p>删除这个连接及其凭据？相关绑定会清除，历史对话保留。</p>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setView(await bridge.deleteProvider(deleteId));
                if (draft?.id === deleteId) {
                  setDraft(null);
                  setDirty(false);
                }
                setDeleteId(null);
                setNotice("连接已删除。");
              } catch {
                setError("删除失败，连接配置已保留。请重试。");
              } finally {
                setBusy(false);
              }
            }}
          >
            确认删除
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setDeleteId(null)}
          >
            取消删除
          </button>
        </div>
      )}
      {pending && (
        <div className="provider-confirm" role="alert">
          <p>当前连接有未保存修改。</p>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (await save()) {
                setDraft(pending);
                setPending(null);
              }
            }}
          >
            保存后继续
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(pending);
              setDirty(false);
              setPending(null);
              setError("");
            }}
          >
            丢弃修改
          </button>
          <button type="button" onClick={() => setPending(null)}>
            继续编辑
          </button>
        </div>
      )}
      {draft && (
        <form
          className="provider-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void save(false, validationUse);
          }}
        >
          <h3>{draft.id ? "编辑连接" : "新增连接"}</h3>
          <fieldset disabled={busy}>
            {!draft.id && (
              <label className="provider-field">
                服务商预设
                <select
                  value={
                    showAntigravity ? "antigravity" : (draft.presetId ?? "")
                  }
                  onChange={(e) => choosePreset(e.target.value)}
                >
                  <option value="">自定义连接</option>
                  {providerPresets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  <option value="antigravity">
                    Google Antigravity · 接入说明
                  </option>
                </select>
                <small>切换服务商会重置未保存配置与 Key。</small>
              </label>
            )}
            {showAntigravity && (
              <div className="provider-help">
                <p>
                  Antigravity 是 Google
                  的代理开发工具，本版不接入它的账号登录或订阅额度。若使用
                  Gemini API Key，请选择 Google Gemini；这不会复用 Antigravity
                  登录凭据。
                </p>
                <button type="button" onClick={() => choosePreset("gemini")}>
                  使用 Gemini API 配置
                </button>
              </div>
            )}
            <div hidden={showAntigravity}>
              {draft.presetId && (
                <>
                  <p className="provider-help">
                    {draft.baseURL}
                    <br />
                    {providerPresets.find((p) => p.id === draft.presetId)?.note}
                  </p>
                  {(!draft.id || draft.credentialAction === "replace") && (
                    <label className="provider-field">
                      API Key
                      <input
                        type="password"
                        autoComplete="new-password"
                        spellCheck={false}
                        value={draft.key}
                        onChange={(e) =>
                          patch({
                            key: e.target.value,
                            credentialAction: "replace",
                          })
                        }
                      />
                    </label>
                  )}
                  {draft.id && draft.credentialAction !== "replace" && (
                    <p>凭据已保存，可在高级配置中替换。</p>
                  )}
                </>
              )}
              <details
                className="provider-advanced"
                open={draft.presetId ? undefined : true}
              >
                <summary>高级连接配置</summary>
                <label className="provider-field">
                  自定义名称
                  <input
                    value={draft.name}
                    maxLength={120}
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </label>
                <label className="provider-field">
                  API 协议
                  <select
                    value={draft.protocol}
                    onChange={(e) =>
                      patch({ protocol: e.target.value as ProviderProtocol })
                    }
                  >
                    {Object.entries(protocols).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="provider-field">
                  Base URL
                  <input
                    value={draft.baseURL}
                    spellCheck={false}
                    onChange={(e) => patch({ baseURL: e.target.value })}
                  />
                </label>
                <p className="provider-help">
                  API 根地址需包含版本或网关前缀，不要粘贴完整端点。目标示例：
                  <code>{endpoint}</code>
                </p>
                <label className="provider-checkbox-row">
                  <input
                    type="checkbox"
                    checked={draft.allowRemoteHTTP}
                    onChange={(e) =>
                      patch({ allowRemoteHTTP: e.target.checked })
                    }
                  />
                  允许远程 HTTP（密钥将以明文传输）
                </label>
                <label className="provider-field">
                  鉴权
                  <select
                    value={draft.authentication}
                    onChange={(e) =>
                      patch({
                        authentication: e.target
                          .value as Draft["authentication"],
                      })
                    }
                  >
                    <option value="api-key">API Key</option>
                    <option value="none">无需 API Key（本地服务）</option>
                  </select>
                </label>
                {draft.authentication === "api-key" && (
                  <>
                    <p>
                      {credential?.set
                        ? credential.encrypted
                          ? "凭据已加密保存；不会读取回明文。"
                          : "旧凭据尚未加密；请替换以迁移。"
                        : "尚未保存 API Key。"}
                    </p>
                    <label className="provider-field">
                      凭据操作
                      <select
                        value={draft.credentialAction}
                        onChange={(e) =>
                          patch({
                            credentialAction: e.target
                              .value as Draft["credentialAction"],
                            key: "",
                          })
                        }
                      >
                        <option value="keep">保留已有凭据</option>
                        <option value="replace">写入或替换 API Key</option>
                        <option value="clear">清除凭据</option>
                      </select>
                    </label>
                    {draft.credentialAction === "replace" &&
                      !draft.presetId && (
                        <label className="provider-field">
                          API Key
                          <input
                            type="password"
                            autoComplete="new-password"
                            spellCheck={false}
                            value={draft.key}
                            onChange={(e) => patch({ key: e.target.value })}
                          />
                        </label>
                      )}
                  </>
                )}
                <label className="provider-field">
                  请求超时（秒）
                  <input
                    type="number"
                    min={1}
                    max={600}
                    value={draft.timeoutMs / 1000}
                    onChange={(e) =>
                      patch({ timeoutMs: Number(e.target.value) * 1000 })
                    }
                  />
                </label>
              </details>
              <details
                open={draft.presetId ? undefined : true}
                className="provider-advanced"
              >
                <summary>手动添加或管理模型</summary>
                <h4>模型列表 · 手动添加</h4>
                <div className="provider-model-add">
                  <label className="provider-field">
                    模型 ID
                    <input
                      value={modelId}
                      spellCheck={false}
                      onChange={(e) => {
                        setModelId(e.target.value);
                        setDirty(true);
                      }}
                    />
                  </label>
                  <label className="provider-field">
                    显示别名（可选）
                    <input
                      value={modelAlias}
                      onChange={(e) => {
                        setModelAlias(e.target.value);
                        setDirty(true);
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!modelId.trim()}
                    onClick={addModel}
                  >
                    添加模型
                  </button>
                </div>
                <ul className="provider-models">
                  {draft.models.map((m) => {
                    const savedProvider = view.settings.providers.find((p) => p.id === draft.id);
                    const saved = savedProvider?.models.find((x) => x.id === m.id);
                    const check = savedProvider && saved ? imageCheckFor(view, savedProvider, saved) : undefined;
                    return (
                    <li key={m.id}>
                      <span title={saved ? checkedTitle(saved, check) : undefined}>
                        {m.alias || m.id}
                        {m.alias && <> <code>{m.id}</code></>}
                        {" · "}
                        {savedProvider && saved ? statusLabel(savedProvider, saved) : validationLabels.unverified}
                        {saved ? imageLabel(saved, check) : ""}
                      </span>
                      <button
                        type="button"
                        aria-label={`移除模型 ${m.id}`}
                        onClick={() => {
                          const models = draft.models.filter(
                            (x) => x.id !== m.id,
                          );
                          patch({
                            models,
                            defaultModel:
                              draft.defaultModel === m.id
                                ? (models[0]?.id ?? "")
                                : draft.defaultModel,
                          });
                        }}
                      >
                        移除
                      </button>
                    </li>
                    );
                  })}
                </ul>
              </details>
              <label className="provider-field">
                默认模型
                <select
                  value={draft.defaultModel}
                  onChange={(e) => patch({ defaultModel: e.target.value })}
                >
                  <option value="">请选择模型</option>
                  {draft.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.alias || m.id}
                    </option>
                  ))}
                </select>
              </label>
              {draft.presetId && (
                <p className="provider-help">
                  预设是常用模型建议，账户能否使用以验证为准。
                </p>
              )}
              <div className="provider-actions">
                {draft.presetId && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void save(true)}
                  >
                    保存并获取账户模型
                  </button>
                )}
                <button
                  type="button"
                  disabled={!draft.id || dirty || busy}
                  onClick={() => void probe("models")}
                >
                  获取模型
                </button>
                <button
                  type="button"
                  disabled={!draft.id || dirty || busy}
                  onClick={() => void probe("text")}
                >
                  测试文本
                </button>
                <button
                  type="button"
                  disabled={!draft.id || dirty || busy}
                  onClick={() => void probe("tools")}
                >
                  测试工具
                </button>
                <button
                  type="button"
                  disabled={!draft.id || dirty || busy}
                  onClick={() => void probe("images")}
                >
                  测试识图
                </button>
              </div>
              <label className="provider-field">验证用途
                <select value={validationUse} onChange={e => setValidationUse(e.target.value as "text" | "tools")}>
                  <option value="tools">编程（文本与工具）</option><option value="text">仅聊天（文本）</option>
                </select>
              </label>
              <p className="provider-help">“保存并验证”会发送小型测试请求，可能消耗少量额度；只保存连接不发送请求。</p>
              <div className="provider-actions">
                <button type="submit">{busy ? "正在处理…" : "保存并验证"}</button>
                <button type="button" onClick={() => void save()}>保存连接</button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(null);
                    setDirty(false);
                    setError("");
                  }}
                >
                  丢弃并关闭编辑
                </button>
              </div>
            </div>
          </fieldset>
        </form>
      )}
      <details className="provider-bindings">
        <summary>高级设置 · 对话与编程模型</summary>
        <label className="provider-field">
          绑定范围
          <select
            value={scope}
            disabled={busy || dirty}
            onChange={(e) => setScope(e.target.value as "global" | "session")}
          >
            <option value="global">全局默认</option>
            {sessionId && <option value="session">当前任务覆盖</option>}
          </select>
        </label>
        {scope === "session" && <p>仅覆盖当前任务；清除后沿用全局默认。</p>}
        {bindingSelect("persona", "黑塔对话模型")}
        <label className="provider-checkbox-row">
          <input
            type="checkbox"
            checked={separate}
            disabled={busy}
            onChange={(e) => {
              setBindingsDirty(true);
              setSeparate(e.target.checked);
              if (!e.target.checked && bindings)
                setBindings({
                  persona: bindings.persona,
                  executor: bindings.persona,
                });
            }}
          />
          分别选择编程执行模型
        </label>
        {separate && bindingSelect("executor", "编程执行模型")}
        <p>
          改动从下一轮生效。编程执行模型需通过工具验证；文本可用不代表工具可用。
        </p>
        <div className="provider-actions">
          <button
            type="button"
            disabled={busy || !bindings}
            onClick={() => void saveBindings()}
          >
            保存模型绑定
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void saveBindings(true)}
          >
            {scope === "session" ? "清除任务覆盖" : "清除默认绑定"}
          </button>
        </div>
      </details>
    </div>
  );
}
