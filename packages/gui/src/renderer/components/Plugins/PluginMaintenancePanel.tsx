import { useEffect, useId, useRef, useState } from "react";
import type { PluginMaintenanceCategory, PluginMaintenancePreview, PluginMaintenanceResult } from "../../../shared/plugin-maintenance.js";
import type { HertaBridge } from "../../ipc/bridge-types.js";

const CATEGORY: Record<PluginMaintenanceCategory, string> = { blob: "未引用插件包", temporary: "安装临时文件", archive: "旧归档" };
const amount = (bytes: number) => bytes < 1024 ? `${bytes.toLocaleString("zh-CN")} B`
  : bytes < 1024 * 1024 ? `${(bytes / 1024).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} KiB`
    : `${(bytes / (1024 * 1024)).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} MiB`;

/** Only host-issued candidate IDs cross back to the main process. No paths,
 * implicit selection, expanded deletion set, or automatic retries originate here. */
export function PluginMaintenancePanel({ request, hostRevision, disabled, onChanged }: {
  request: NonNullable<HertaBridge["executablePlugins"]>;
  hostRevision: number;
  disabled: boolean;
  onChanged(): void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [preview, setPreview] = useState<PluginMaintenancePreview>(), [result, setResult] = useState<PluginMaintenanceResult>();
  const [selected, setSelected] = useState<string[]>([]);
  const generation = useRef(0), lock = useRef(false), token = useRef<string>(), panel = useRef<HTMLElement>(null), heading = useId();
  const discard = (id: string) => { void request({ kind: "maintenance-discard", previewId: id }).catch(() => {}); };
  const drop = () => { const id = token.current; token.current = undefined; if (id) discard(id); };
  useEffect(() => {
    generation.current++; lock.current = false; setOpen(false); setBusy(false); setError(""); setPreview(undefined); setResult(undefined); setSelected([]);
    return () => { generation.current++; lock.current = false; drop(); };
  }, [request, hostRevision]);
  useEffect(() => { if (preview) panel.current?.focus({ preventScroll: true }); }, [preview?.id]);

  async function inspect() {
    if (lock.current || disabled) return;
    drop(); const revision = ++generation.current; lock.current = true;
    setOpen(true); setBusy(true); setError(""); setPreview(undefined); setResult(undefined); setSelected([]);
    try {
      const reply = await request({ kind: "maintenance-preview", hostRevision });
      if (revision !== generation.current) { if (reply.ok && reply.maintenancePreview) discard(reply.maintenancePreview.id); return; }
      if (!reply.ok) { setError(reply.message); return; }
      const next = reply.maintenancePreview;
      if (!next || next.hostRevision !== hostRevision || !Number.isFinite(Date.parse(next.expiresAt)) || Date.parse(next.expiresAt) <= Date.now()) {
        if (next) discard(next.id); setError("清理预览已失效，请重新检查。"); return;
      }
      token.current = next.id; setPreview(next);
    } catch { if (revision === generation.current) setError("未能检查可清理资料，请稍后再试。"); }
    finally { if (revision === generation.current) { lock.current = false; setBusy(false); } }
  }

  async function confirm() {
    if (lock.current || disabled || !preview || !selected.length) return;
    const chosen = preview, ids = chosen.items.filter(item => selected.includes(item.id)).map(item => item.id);
    if (!ids.length) return;
    if (chosen.hostRevision !== hostRevision || Date.parse(chosen.expiresAt) <= Date.now()) {
      drop(); setPreview(undefined); setSelected([]); setError("清理预览已失效，请重新检查。"); return;
    }
    const revision = ++generation.current; lock.current = true; setBusy(true); setError(""); setResult(undefined);
    try {
      const reply = await request({ kind: "maintenance-confirm", previewId: chosen.id, selectedIds: ids, hostRevision });
      if (revision !== generation.current) return;
      // A confirmation is consumed even on failure: a fresh check is required
      // before any further attempt, especially after an uncertain partial result.
      drop(); setPreview(undefined); setSelected([]);
      if (!reply.ok) setError(reply.message + " 请重新检查后再决定，不会自动重试。");
      else if (!reply.maintenanceResult) setError("未能取得清理结果，请重新检查并核对，勿直接重试。");
      else setResult(reply.maintenanceResult);
      onChanged();
    } catch {
      if (revision === generation.current) {
        drop(); setPreview(undefined); setSelected([]);
        setError("未能取得清理结果，部分资料可能已删除。请重新检查并核对，勿直接重试。"); onChanged();
      }
    } finally { if (revision === generation.current) { lock.current = false; setBusy(false); } }
  }
  function close() {
    if (lock.current) return;
    generation.current++; drop(); setOpen(false); setPreview(undefined); setResult(undefined); setSelected([]); setError("");
  }
  const chosen = preview?.items.filter(item => selected.includes(item.id)) ?? [];
  const bytes = chosen.reduce((total, item) => total + item.bytes, 0), archives = chosen.filter(item => item.category === "archive").length;
  return <div className="plugin-maintenance">
    {!open && <button type="button" disabled={disabled} onClick={() => void inspect()}>检查可清理资料</button>}
    {open && <section className="executable-plugin-confirm plugin-maintenance-panel" aria-labelledby={heading} aria-busy={busy} ref={panel} tabIndex={-1}>
      <h4 id={heading}>清理插件资料</h4>
      {busy && <p role="status" className="executable-plugin-muted">{preview ? "正在按已确认范围清理…" : "正在检查资料…"}</p>}
      {error && <p role="alert" className="executable-plugin-error">{error}</p>}
      {preview && <>
        <p className="executable-plugin-muted">保留 {preview.protectedBlobCount} 个被当前版本、历史版本或备份等引用的插件包。</p>
        {!preview.usageKnown && <p className="executable-plugin-muted">部分占用无法完整统计，以下大小仅包含已核对内容，不表示链接目标大小为零。</p>}
        {!!preview.blockedReasons.length && <div className="plugin-maintenance-blocked"><p>部分资料暂不列入清理：</p><ul>{preview.blockedReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></div>}
        {!preview.items.length ? <p>本次没有可确认清理的资料。</p> : <fieldset disabled={disabled || busy} className="plugin-maintenance-choices">
          <legend>选择要删除的资料</legend>
          <ul>{preview.items.map(item => <li key={item.id}>
            <label><input type="checkbox" checked={selected.includes(item.id)} onChange={event => setSelected(previous => event.target.checked
              ? [...previous, item.id] : previous.filter(id => id !== item.id))} />
              <span className="plugin-maintenance-name">{item.label}<small>{CATEGORY[item.category]} · {item.fileCount} 个文件{item.linkCount ? `、${item.linkCount} 个链接入口` : ""}</small></span>
              <span className="plugin-maintenance-bytes">{amount(item.bytes)}</span>
            </label>
            {item.category === "archive" && <p className="plugin-maintenance-warning">删除后将失去从此归档恢复资料的能力。</p>}
            {item.warning && <p className="plugin-maintenance-warning">{item.warning}</p>}
          </li>)}</ul>
        </fieldset>}
        {!!preview.items.length && <>
          <p className="plugin-maintenance-selection">已选 {chosen.length} 个确认项 · 可核对逻辑大小 {amount(bytes)}</p>
          {!!archives && <p className="executable-plugin-error">包含 {archives} 份归档，删除后不能再从这些归档恢复。</p>}
          <p className="executable-plugin-muted">只删除勾选的资料，不自动扩展范围；私有资料、生成文件和修改提案不在本次清理中。</p>
          <button type="button" className="plugin-maintenance-delete" disabled={disabled || busy || !chosen.length} onClick={() => void confirm()}>确认删除 {chosen.length} 项</button>
        </>}
      </>}
      {result && <div className="plugin-maintenance-result" role="status">
        <p>{result.cancelled ? "清理已中止。" : result.failedCount || result.retainedCount ? "本次清理未全部完成。" : "清理完成。"}已完整删除 {result.deletedCount} 个确认项。</p>
        <p>已删除文件的逻辑大小：{amount(result.deletedBytes)}。</p>
        {!!result.retainedCount && <p>未完整删除 {result.retainedCount} 项，其中失败 {result.failedCount} 项。</p>}
        {!result.usageKnown && <p className="executable-plugin-muted">仍有无法完整统计的占用，不能据此计算实际磁盘释放量。</p>}
        {!!result.issues.length && <ul>{result.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
        {(result.cancelled || result.retainedCount > 0 || result.failedCount > 0) && <p>请重新检查后再决定，不会自动重试。</p>}
      </div>}
      <div className="executable-plugin-buttons">
        <button type="button" disabled={disabled || busy} onClick={() => void inspect()}>重新检查可清理资料</button>
        <button type="button" disabled={busy} onClick={close}>关闭清理预览</button>
      </div>
    </section>}
  </div>;
}
