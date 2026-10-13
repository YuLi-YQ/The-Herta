import { useEffect, useState } from "react";
import {
  boundedSearchEvents,
  webSearchSupport,
  type WebSearchEvent,
} from "@herta/providers/web-search";
import type { ProviderReadiness } from "../../shared/provider-settings-ipc.js";
import { useHertaBridge } from "../context/HertaBridgeContext.js";

export function SearchResults({
  events,
  running = false,
}: {
  events?: WebSearchEvent[];
  running?: boolean;
}) {
  const { bridge } = useHertaBridge();
  const [error, setError] = useState("");
  const items = boundedSearchEvents(events);
  if (!items.length) return null;
  return (
    <details className="herta-search-results" open>
      <summary>联网搜索与来源</summary>
      {items.map((item) => (
        <div
          key={item.id}
          className={item.status === "failed" ? "round-failed" : ""}
        >
          {item.status !== "citation" && (
            <p>
              {item.status === "searching"
                ? running
                  ? "搜索中"
                  : "搜索未完成"
                : item.status === "failed"
                  ? "搜索失败"
                  : "搜索完成"}
              {item.query ? ` · ${item.query}` : ""}
              {item.error ? `（${item.error}）` : ""}
            </p>
          )}
          {item.sources?.map((source) => (
            <a
              key={source.url}
              href={source.url}
              onClick={(e) => {
                e.preventDefault();
                void bridge
                  .openExternal?.(source.url)
                  .catch(() => setError("链接未能打开"));
              }}
            >
              {source.title || source.url}
            </a>
          ))}
        </div>
      ))}
      {error && <p role="status">{error}</p>}
    </details>
  );
}

export function SearchToggle({
  supported,
  enabled,
  disabled,
  onChange,
}: {
  supported: boolean;
  enabled: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="herta-search-toggle"
      aria-label="允许联网搜索"
      aria-pressed={supported && enabled}
      disabled={disabled || !supported}
      title={
        supported
          ? "允许服务端搜索，可能产生额外用量；关闭不限制工作台命令联网。"
          : "当前连接或模型的服务端搜索尚未适配。"
      }
      onClick={() => onChange(!enabled)}
    >
      ◎ 联网{supported && enabled ? " · 开" : ""}
    </button>
  );
}

export function WorkbenchSearch({
  readiness,
  sessionId,
  busy,
  refresh,
}: {
  readiness: ProviderReadiness | null;
  sessionId: string | null;
  busy: boolean;
  refresh: () => Promise<void>;
}) {
  const { bridge } = useHertaBridge();
  const [supported, setSupported] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const binding = readiness?.bindings?.persona;
  useEffect(() => {
    let active = true;
    setSupported(false);
    void bridge
      .getProviderSettings?.()
      .then((view) => {
        const provider = view.settings.providers.find(
          (p) => p.id === binding?.providerId,
        );
        if (active)
          setSupported(
            !!provider &&
              !!binding &&
              provider.models.some(m => m.id === binding.modelId && m.validation?.state === "tools-available") &&
              webSearchSupport(provider, binding.modelId),
          );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [
    bridge,
    binding?.providerId,
    binding?.modelId,
    readiness?.ready,
    sessionId,
  ]);
  return (
    <>
      <SearchToggle
        supported={supported}
        enabled={binding?.webSearch === true}
        disabled={busy || saving || !sessionId || !readiness?.ready}
        onChange={(value) => {
          if (!readiness?.bindings || !sessionId || !bridge.setProviderBindings)
            return;
          setSaving(true);
          setError("");
          void bridge
            .setProviderBindings({
              sessionId,
              bindings: {
                ...readiness.bindings,
                persona: { ...binding!, webSearch: value },
              },
            })
            .then(refresh)
            .catch(() => setError("联网设置未保存"))
            .finally(() => setSaving(false));
        }}
      />
      {error && <span role="status">{error}</span>}
    </>
  );
}
