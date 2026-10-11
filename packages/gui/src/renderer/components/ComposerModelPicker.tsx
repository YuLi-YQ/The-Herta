import { useEffect, useRef, useState } from "react";
import type { ModelBinding, RoleBindings } from "@herta/providers";
import { reasoningChoices } from "@herta/providers/reasoning";
import type {
  ProviderReadiness,
  ProviderSettingsView,
} from "../../shared/provider-settings-ipc.js";
import { useHertaBridge } from "../context/HertaBridgeContext.js";

export function ComposerModelPicker({
  readiness,
  sessionId,
  busy,
  refresh,
  manage,
}: {
  readiness: ProviderReadiness | null;
  sessionId: string | null;
  busy: boolean;
  refresh: () => Promise<void>;
  manage: () => void;
}): JSX.Element {
  const { bridge } = useHertaBridge();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ProviderSettingsView | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [role, setRole] = useState<"persona" | "executor">("persona");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setError("");
    void bridge
      .getProviderSettings?.()
      .then((v) => {
        if (active) setView(v);
      })
      .catch(() => {
        if (active) setError("无法读取模型配置。");
      });
    const outside = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const blur = () => setOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("blur", blur);
    return () => {
      active = false;
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("blur", blur);
    };
  }, [open, bridge]);
  const bindings = readiness?.bindings;
  const selected = bindings?.[role];
  const provider = view?.settings.providers.find(
    (p) => p.id === selected?.providerId,
  );
  const choices =
    provider && selected ? reasoningChoices(provider, selected.modelId) : [];
  const labels: Record<string, string> = {
    none: "关闭",
    enabled: "开启",
    low: "轻度",
    medium: "标准",
    high: "深度",
    max: "最高",
  };
  async function save(binding: ModelBinding) {
    if (!bridge.setProviderBindings || busy || saving) return;
    setSaving(true);
    setError("");
    try {
      const unified =
        !bindings ||
        (bindings.persona.providerId === bindings.executor.providerId &&
          bindings.persona.modelId === bindings.executor.modelId);
      let next: RoleBindings = bindings
        ? { ...bindings, [role]: binding }
        : { persona: binding, executor: binding };
      const candidate = view?.settings.providers
        .find((p) => p.id === binding.providerId)
        ?.models.find((m) => m.id === binding.modelId);
      if (
        role === "persona" &&
        unified &&
        candidate?.validation.state === "tools-available"
      )
        next = { ...next, executor: binding };
      await bridge.setProviderBindings({
        ...(sessionId ? { sessionId } : {}),
        bindings: next,
      });
      await refresh();
    } catch {
      setError("未能保存选择，请检查模型配置。");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="composer-model-picker" ref={root}>
      <button
        type="button"
        className="herta-model-status"
        ref={trigger}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        {bindings?.persona.modelId ?? "选择模型"}
        {bindings?.persona.reasoningEffort
          ? ` · ${labels[bindings.persona.reasoningEffort] ?? bindings.persona.reasoningEffort}`
          : ""}{" "}
        ▾
      </button>
      {open && (
        <section
          className="composer-model-popover"
          role="dialog"
          aria-label="选择模型与思考强度"
        >
          <div className="composer-model-roles">
            <button
              type="button"
              aria-pressed={role === "persona"}
              onClick={() => setRole("persona")}
            >
              黑塔对话
            </button>
            <button
              type="button"
              aria-pressed={role === "executor"}
              onClick={() => setRole("executor")}
            >
              编程执行器
            </button>
          </div>
          {busy && <p>本轮执行中，结束后可切换。</p>}
          {!view && <p>正在读取模型…</p>}
          {view?.settings.providers.map((p) => (
            <div key={p.id}>
              <small>{p.name}</small>
              {p.models.map((m) => {
                const checked =
                  selected?.providerId === p.id && selected.modelId === m.id;
                const valid =
                  m.validation.providerRevision === p.revision &&
                  (m.validation.state === "tools-available" ||
                    (role === "persona" &&
                      m.validation.state === "text-available"));
                return (
                  <button
                    className="composer-model-option"
                    type="button"
                    key={m.id}
                    aria-pressed={checked}
                    disabled={busy || saving || !valid}
                    title={valid ? m.id : "请先在设置中验证模型"}
                    onClick={() =>
                      void save({ providerId: p.id, modelId: m.id })
                    }
                  >
                    <span>
                      {m.alias || m.id}
                      {!valid ? " · 待验证" : ""}
                    </span>
                    <span>{checked ? "✓" : ""}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {view && !view.settings.providers.length && <p>尚未添加模型。</p>}
          <label>
            思考强度
            <select
              aria-label="思考强度"
              value={selected?.reasoningEffort ?? ""}
              disabled={!selected || busy || saving}
              onChange={(e) => {
                if (selected) {
                  const { reasoningEffort: _, ...base } = selected;
                  void save({
                    ...base,
                    ...(e.target.value
                      ? { reasoningEffort: e.target.value }
                      : {}),
                  });
                }
              }}
            >
              <option value="">服务默认</option>
              {choices.map((c) => (
                <option value={c} key={c}>
                  {labels[c]}
                </option>
              ))}
            </select>
          </label>
          {selected && !choices.length && (
            <small>此模型暂未声明可调强度，使用服务默认。</small>
          )}
          {error && <p role="alert">{error}</p>}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              manage();
            }}
          >
            管理连接与模型
          </button>
        </section>
      )}
    </div>
  );
}
