import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { PluginStorageCategoryId, PluginStorageSnapshot } from "../../../shared/plugin-storage.js";
import type { HertaBridge } from "../../ipc/bridge-types.js";

const LABELS: Record<PluginStorageCategoryId, string> = {
  packages: "插件包", "private-data": "插件私有资料", artifacts: "生成文件", proposals: "修改提案", workshop: "制作草稿",
};
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString("zh-CN")} B`;
  const unit = bytes >= 1024 * 1024 ? "MiB" : "KiB", value = bytes / (unit === "MiB" ? 1024 * 1024 : 1024);
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} ${unit}`;
}

/** Host data only. This is an explicit refresh, never a polling loop or cleanup action. */
export function PluginStorageSummary({ request, refreshKey }: {
  request: NonNullable<HertaBridge["executablePlugins"]>;
  refreshKey: number;
}) {
  const headingId = useId(), generation = useRef(0), inFlight = useRef(false), previousRequest = useRef(request);
  const [storage, setStorage] = useState<PluginStorageSnapshot>();
  const [busy, setBusy] = useState(true), [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string>();
  const refresh = useCallback(async (supersede = false) => {
    if (inFlight.current && !supersede) return;
    const token = ++generation.current; inFlight.current = true; setBusy(true); setError("");
    try {
      const reply = await request({ kind: "storage-usage" });
      if (generation.current !== token) return;
      if (!reply.ok) { setError(reply.message); return; }
      if (!reply.storage) { setError("暂时无法统计插件空间，请重试。"); return; }
      setStorage(reply.storage);
      setUpdatedAt(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
    } catch {
      if (generation.current === token) setError("暂时无法统计插件空间，请重试。");
    } finally {
      if (generation.current === token) { inFlight.current = false; setBusy(false); }
    }
  }, [request]);
  useEffect(() => {
    if (previousRequest.current !== request) { setStorage(undefined); setUpdatedAt(undefined); previousRequest.current = request; }
    void refresh(true);
    return () => { generation.current++; inFlight.current = false; };
  }, [refresh, refreshKey, request]);

  return <section className="plugin-storage-summary" aria-labelledby={headingId} aria-busy={busy}>
    <div className="plugin-storage-summary-heading">
      <h4 id={headingId}>插件空间</h4>
      <button type="button" disabled={busy} onClick={() => void refresh()} aria-label="刷新插件空间">刷新</button>
    </div>
    <p className="plugin-storage-total" role="status" aria-atomic="true">
      {storage ? <><strong>{size(storage.usedBytes)}</strong><span className="executable-plugin-muted"> / {size(storage.limitBytes)}</span></>
        : <span className="executable-plugin-muted">{busy ? "正在统计…" : "尚未取得统计"}</span>}
    </p>
    {storage && <>
      <div className={`plugin-storage-meter${storage.overLimit ? " is-over-limit" : ""}`} role="meter" aria-label="插件空间使用量"
        aria-valuemin={0} aria-valuemax={storage.limitBytes} aria-valuenow={Math.min(storage.usedBytes, storage.limitBytes)}
        aria-valuetext={`已用 ${size(storage.usedBytes)}，上限 ${size(storage.limitBytes)}${storage.overLimit ? "，已超限" : ""}`}>
        <span style={{ width: `${Math.min(100, Math.max(0, storage.usedBytes / storage.limitBytes * 100))}%` }} />
      </div>
      <p className="executable-plugin-muted plugin-storage-freshness">
        {busy ? "正在刷新，显示上次统计。" : error ? "显示上次成功统计。" : `统计于 ${updatedAt}`}
      </p>
    </>}
    {error && <p role="alert" className="executable-plugin-error">{error}</p>}
    {storage?.overLimit && <p className="executable-plugin-error">{busy || error ? "上次统计已超过空间上限。" : "已超过空间上限，新增写入会被拒绝；已有资料仍保留。"}</p>}
    {storage && <details className="plugin-storage-breakdown">
      <summary>查看占用明细</summary>
      <dl>{storage.categories.map(category => <div key={category.id}>
        <dt>{LABELS[category.id]}</dt><dd>{size(category.usedBytes)}</dd>
      </div>)}</dl>
      <p className="executable-plugin-muted">包含备份、归档与临时文件；按文件内容大小统计。</p>
    </details>}
  </section>;
}
