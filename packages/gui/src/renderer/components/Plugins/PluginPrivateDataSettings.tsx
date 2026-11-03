import { useEffect, useRef, useState } from "react";
import type { PrivatePluginDataAction, PrivatePluginDataInfo, PrivatePluginDataPreview } from "../../../shared/plugin-private-data.js";
import type { HertaBridge } from "../../ipc/bridge-types.js";

const amount = (bytes: number) => bytes < 1024 ? `${bytes.toLocaleString("zh-CN")} B` : `${(bytes / 1024).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} KiB`;
const description = (info: PrivatePluginDataInfo) => info.state === "missing" ? "尚无资料" : info.state === "damaged" ? "无法读取" : `${info.keys ?? 0} 项 · ${amount(info.bytes)}`;
const time = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "";

/** Metadata and explicit confirmation only. Never displays or executes private values. */
export function PluginPrivateDataSettings({ request, pluginId, hostRevision, disabled, onChanged }: {
  request: NonNullable<HertaBridge["executablePlugins"]>;
  pluginId: string;
  hostRevision: number;
  disabled: boolean;
  onChanged(): void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<PrivatePluginDataPreview>();
  const generation = useRef(0), lock = useRef(false), token = useRef<string>(), panel = useRef<HTMLElement>(null);
  const drop = () => { const id = token.current; token.current = undefined; if (id) void request({ kind: "private-data-discard", previewId: id }).catch(() => {}); };
  useEffect(() => {
    generation.current++; lock.current = false; setPreview(undefined); setOpen(false); setBusy(false); setError(""); setNotice("");
    return () => { generation.current++; lock.current = false; drop(); };
  }, [request, pluginId, hostRevision]);
  useEffect(() => { if (preview) panel.current?.focus({ preventScroll: true }); }, [preview?.id]);
  async function inspect(action: PrivatePluginDataAction) {
    if (lock.current || disabled) return;
    drop(); const revision = ++generation.current; lock.current = true;
    setOpen(true); setPreview(undefined); setBusy(true); setError(""); setNotice("");
    try {
      const reply = await request({ kind: "private-data-preview", pluginId, action, hostRevision });
      if (revision !== generation.current) {
        if (reply.ok && reply.privateDataPreview) void request({ kind: "private-data-discard", previewId: reply.privateDataPreview.id }).catch(() => {});
        return;
      }
      if (!reply.ok) { setError(reply.message); return; }
      const next = reply.privateDataPreview;
      if (!next || next.pluginId !== pluginId || next.hostRevision !== hostRevision || next.action !== action) {
        if (next) void request({ kind: "private-data-discard", previewId: next.id }).catch(() => {});
        setError("资料预览已变化，请重新查看。"); return;
      }
      token.current = next.id; setPreview(next);
    } catch { if (revision === generation.current) setError("暂时无法查看插件资料，请重试。"); }
    finally { if (revision === generation.current) { lock.current = false; setBusy(false); } }
  }
  async function confirm() {
    if (!preview?.canConfirm || preview.hostRevision !== hostRevision || lock.current || disabled) return;
    const chosen = preview, revision = ++generation.current; lock.current = true; setBusy(true); setError("");
    try {
      const reply = await request({ kind: "private-data-confirm", previewId: chosen.id, hostRevision });
      if (revision !== generation.current) return;
      drop(); setPreview(undefined);
      if (!reply.ok) { setError(reply.message); return; }
      const result = reply.privateDataResult;
      if (!result || result.pluginId !== pluginId || result.action !== chosen.action) { setError("未能取得完成记录，请重新查看资料。"); return; }
      setNotice(`${result.action === "restore" ? "资料已恢复。" : "已建立空白资料。"}${result.archived ? "原资料已另存。" : ""}`); onChanged();
    } catch { if (revision === generation.current) { drop(); setPreview(undefined); setError("未能取得完成记录，请重新查看后核对，勿直接重试。"); } }
    finally { if (revision === generation.current) { lock.current = false; setBusy(false); } }
  }
  const close = () => { if (lock.current) return; generation.current++; drop(); setPreview(undefined); setOpen(false); setError(""); setNotice(""); };
  return <div className="plugin-private-data">
    {!open && <button type="button" disabled={disabled} onClick={() => void inspect("restore")}>资料与备份</button>}
    {open && <section className="executable-plugin-confirm" ref={panel} tabIndex={-1} aria-label="插件资料与备份" aria-busy={busy}>
      <h5>资料与备份</h5>
      {busy && <p role="status" className="executable-plugin-muted">正在处理资料…</p>}
      {error && <p role="alert" className="executable-plugin-error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {preview && <>
        <dl className="plugin-private-data-facts"><div><dt>当前资料</dt><dd>{description(preview.current)}</dd></div>
          <div><dt>资料备份</dt><dd>{description(preview.backup)}{time(preview.backup.savedAt) && <small>{time(preview.backup.savedAt)}</small>}</dd></div></dl>
        {preview.warning && <p className="executable-plugin-muted">{preview.warning}</p>}
        <p>{preview.action === "reset" ? "先另存原资料和备份，再建立空白资料。此操作不影响聊天、项目或生成文件。" : "将备份恢复为当前资料；原资料会先另存。"}</p>
        <div className="executable-plugin-buttons"><button type="button" disabled={disabled || busy || !preview.canConfirm} onClick={() => void confirm()}>{preview.action === "restore" ? "确认恢复备份" : "确认重建资料"}</button>
          <button type="button" disabled={disabled || busy} onClick={() => void inspect(preview.action === "restore" ? "reset" : "restore")}>{preview.action === "restore" ? "重建空白资料…" : "返回备份预览"}</button></div>
      </>}
      <div className="executable-plugin-buttons">{!preview && <button type="button" disabled={disabled || busy} onClick={() => void inspect("restore")}>重新查看资料</button>}
        <button type="button" disabled={busy} onClick={close}>关闭资料预览</button></div>
    </section>}
  </div>;
}
