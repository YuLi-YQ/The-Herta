import { useEffect, useRef, useState } from "react";
import type { ExecutablePluginCapabilityName } from "../../../shared/executable-plugins.js";
import type {
  ExecutablePluginManagementRequest, ExecutablePluginPreview, ExecutablePluginSnapshot, InstalledExecutablePlugin,
} from "../../../shared/executable-plugin-management.js";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { PluginStorageSummary } from "./PluginStorageSummary.js";
import { PluginPrivateDataSettings } from "./PluginPrivateDataSettings.js";
import { PluginMaintenancePanel } from "./PluginMaintenancePanel.js";
import { PluginInstallDiff } from "./PluginInstallDiff.js";
import { PermissionChoices, executableCapabilityLabel } from "./PluginPermissionChoices.js";
import { PluginWorkshopPanel } from "./PluginWorkshopPanel.js";
import { PluginNetworkSettings } from "./PluginNetworkSettings.js";
export { executableCapabilityLabel } from "./PluginPermissionChoices.js";
import "../../styles/executable-plugins.css";

const areaLabel = (scope: "chat" | "workbench" | "both") => scope === "both" ? "聊天与工作台" : scope === "chat" ? "聊天" : "工作台";

/** This panel manages frozen installation previews; checking a box never installs or runs a plugin. */
export function ExecutablePluginSettings() {
  const { bridge } = useHertaBridge(), api = bridge.executablePlugins;
  const [snapshot, setSnapshot] = useState<ExecutablePluginSnapshot>({ revision: 0, hostRevision: 0, items: [] });
  const [preview, setPreview] = useState<ExecutablePluginPreview>();
  const [available, setAvailable] = useState<readonly ExecutablePluginCapabilityName[]>([]);
  const [grants, setGrants] = useState<ExecutablePluginCapabilityName[]>([]);
  const [editing, setEditing] = useState<string>();
  const [remove, setRemove] = useState<string>();
  const [reset, setReset] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [privateDataRevision, setPrivateDataRevision] = useState(0);
  const [workshopOpen, setWorkshopOpen] = useState(false), [workshopBusy, setWorkshopBusy] = useState(false);
  const managementBusy = busy || workshopBusy;
  const generation = useRef(0), lock = useRef(false), previewPanel = useRef<HTMLElement>(null);

  useEffect(() => {
    generation.current++; lock.current = false;
    setSnapshot({ revision: 0, hostRevision: 0, items: [] }); setPreview(undefined); setError("");
    if (api) void perform({ kind: "list" });
    return () => { generation.current++; lock.current = false; };
  }, [api]);
  useEffect(() => {
    const id = preview?.id;
    if (id) previewPanel.current?.focus({ preventScroll: true });
    return () => { if (id) void api?.({ kind: "discard", previewId: id }).catch(() => {}); };
  }, [api, preview?.id]);

  async function perform(input: ExecutablePluginManagementRequest, success = "") {
    if (!api || lock.current || workshopBusy) return;
    lock.current = true; const token = ++generation.current;
    setBusy(true); setError(""); setNotice("");
    try {
      const reply = await api(input);
      if (token !== generation.current) {
        if (reply.ok && reply.preview) void api({ kind: "discard", previewId: reply.preview.id }).catch(() => {});
        return;
      }
      if (!reply.ok) { setError(reply.message); return; }
      if (!reply.snapshot) { setError("未能读取插件列表，请刷新后重试。"); return; }
      setSnapshot(reply.snapshot);
      if (reply.availableCapabilities) setAvailable(reply.availableCapabilities);
      setPreview(reply.preview); setGrants([]); setEditing(undefined); setRemove(undefined); setReset(false);
      setNotice(success);
    } catch { if (token === generation.current) setError("插件操作未完成，请重试。现有配置仍保留。"); }
    finally { if (token === generation.current) { lock.current = false; setBusy(false); } }
  }
  function edit(item: InstalledExecutablePlugin) {
    setPreview(undefined); setRemove(undefined); setEditing(item.manifest.id);
    setGrants(item.grantedCapabilities.map(capability => capability.name)); setNotice(""); setError("");
  }
  if (!api) return null;
  return <section className="executable-plugin-settings" aria-label="执行插件" aria-busy={busy}>
    <header className="executable-plugin-heading"><div><h3>执行插件</h3><p className="executable-plugin-muted">把重复工作交给小工具，开放哪些权限由你决定。</p></div>
      <div className="executable-plugin-buttons"><button type="button" disabled={managementBusy || snapshot.damaged} onClick={() => void perform({ kind: "preview" })}>从文件添加</button>
        <button type="button" disabled={managementBusy || !!snapshot.damaged || workshopOpen} onClick={() => { setPreview(undefined); setEditing(undefined); setRemove(undefined); setWorkshopOpen(true); }}>让黑塔制作</button>
        <button type="button" disabled={managementBusy} onClick={() => void perform({ kind: "list" })}>刷新插件</button></div></header>
    {workshopOpen && <PluginWorkshopPanel request={api} getProviderSettings={bridge.getProviderSettings} hostRevision={snapshot.hostRevision} available={available}
      disabled={busy || !!snapshot.damaged} onBusyChange={setWorkshopBusy} onClose={() => setWorkshopOpen(false)} onChanged={() => setPrivateDataRevision(value => value + 1)}
      onInstalled={next => { setSnapshot(next); setPrivateDataRevision(value => value + 1); setNotice("工坊候选已安装，可在下方管理或从快捷操作使用。"); }} />}
    <PluginStorageSummary request={api} refreshKey={snapshot.hostRevision + privateDataRevision} />
    <PluginMaintenancePanel request={api} hostRevision={snapshot.hostRevision} disabled={managementBusy}
      onChanged={() => setPrivateDataRevision(value => value + 1)} />
    <PluginNetworkSettings request={api} disabled={managementBusy} />
    {busy && <p role="status">正在处理插件…</p>}{error && <p role="alert" className="executable-plugin-error">{error}</p>}
    {notice && <p role="status" className="executable-plugin-muted">{notice}</p>}
    {snapshot.damaged && <div className="executable-plugin-confirm" role="alert"><p>执行插件记录无法读取，原文件仍保留。</p>
      <div className="executable-plugin-buttons"><button type="button" disabled={managementBusy} onClick={() => void perform({ kind: "restore" }, "插件记录已恢复。")}>恢复插件备份</button>
        <button type="button" disabled={managementBusy} onClick={() => setReset(true)}>重新建立插件列表</button></div>
      {reset && <div><p>先归档现有插件文件和记录，再重新建立列表。之后需重新安装插件；聊天和项目文件保留。</p><div className="executable-plugin-buttons">
        <button type="button" disabled={managementBusy} onClick={() => void perform({ kind: "reset" }, "已重新建立执行插件列表。")}>确认重建执行插件列表</button>
        <button type="button" disabled={managementBusy} onClick={() => setReset(false)}>取消重建</button></div></div>}</div>}
    {preview && <section ref={previewPanel} tabIndex={-1} className="executable-plugin-preview" aria-label="执行插件安装预览">
      <header className="executable-plugin-heading"><h4>{preview.manifest.name}</h4><span className="executable-plugin-meta">{preview.existing ? `${preview.existing.manifest.version} → ${preview.manifest.version}` : preview.manifest.version}</span></header>
      {preview.manifest.description && <p>{preview.manifest.description}</p>}
      {preview.source === "rollback" && <p>将恢复到所选版本，请重新确认允许的操作。</p>}
      <PluginInstallDiff preview={preview} />
      <PermissionChoices capabilities={preview.manifest.capabilities} selected={grants} available={available} disabled={managementBusy} onChange={setGrants} />
      {!!preview.manifest.capabilities.length && <p className="executable-plugin-muted">只开放勾选的权限；未授权的操作不能运行。</p>}
      <details><summary>{preview.manifest.actions.length} 个操作</summary><ul className="executable-plugin-details-list">{preview.manifest.actions.map(action => <li key={action.id}>{action.title}<small>{areaLabel(action.scope)}</small></li>)}</ul></details>
      <div className="executable-plugin-buttons"><button type="button" disabled={managementBusy || preview.identical} onClick={() => void perform({ kind: "confirm", previewId: preview.id, revision: snapshot.revision, grants }, "插件已保存。")}>
        {preview.identical ? "已是相同内容" : preview.source === "rollback" ? "确认恢复此版本" : preview.existing ? "确认更新插件" : "确认安装插件"}</button>
        <button type="button" disabled={managementBusy} onClick={() => setPreview(undefined)}>取消安装</button></div>
    </section>}
    {!busy && !snapshot.damaged && !snapshot.items.length && <p className="executable-plugin-muted">还没有执行插件。从文件添加后，即可在快捷操作中使用。</p>}
    <div className="executable-plugin-list">{snapshot.items.map(item => <article className="executable-plugin-row" key={item.manifest.id}>
      <header className="executable-plugin-heading"><div><h4>{item.manifest.name}<span className="executable-plugin-meta">{item.manifest.version}</span></h4>
        {item.manifest.description && <p className="executable-plugin-muted">{item.manifest.description}</p>}</div>
        <button type="button" aria-label={`${item.enabled ? "停用" : "启用"}${item.manifest.name}`} aria-pressed={item.enabled} disabled={managementBusy || snapshot.damaged}
          onClick={() => void perform({ kind: "enable", id: item.manifest.id, enabled: !item.enabled, revision: snapshot.revision })}>{item.enabled ? "已启用" : "已停用"}</button></header>
      <details><summary>权限与操作</summary><ul className="executable-plugin-details-list">{item.manifest.actions.map(action => <li key={action.id}>{action.title}<small>{areaLabel(action.scope)}</small></li>)}</ul>
        <p className="executable-plugin-muted">{item.grantedCapabilities.length ? `已允许：${item.grantedCapabilities.map(capability => executableCapabilityLabel(capability.name)).join("、")}` : "未开放额外权限。"}</p>
      </details>
      <div className="executable-plugin-buttons"><button type="button" disabled={managementBusy || snapshot.damaged} onClick={() => edit(item)}>调整权限</button>
        <button type="button" disabled={managementBusy || snapshot.damaged} onClick={() => { setRemove(item.manifest.id); setEditing(undefined); }}>移除插件</button></div>
      {editing === item.manifest.id && <div className="executable-plugin-confirm"><PermissionChoices capabilities={item.manifest.capabilities} selected={grants} available={available} disabled={managementBusy} onChange={setGrants} />
        <div className="executable-plugin-buttons"><button type="button" disabled={managementBusy} onClick={() => void perform({ kind: "grants", id: item.manifest.id, grants, revision: snapshot.revision }, "插件权限已更新。")}>保存插件权限</button>
          <button type="button" disabled={managementBusy} onClick={() => setEditing(undefined)}>取消调整</button></div></div>}
      {!!item.history.length && <details><summary>历史版本</summary><ul className="executable-plugin-history">{item.history.map(version => <li key={version.contentHash}><span>{version.version}</span>
        <button type="button" disabled={managementBusy || snapshot.damaged} onClick={() => void perform({ kind: "rollback-preview", id: item.manifest.id, contentHash: version.contentHash, revision: snapshot.revision })}>恢复至 {version.version}</button></li>)}</ul></details>}
      <PluginPrivateDataSettings request={api} pluginId={item.manifest.id} hostRevision={snapshot.hostRevision} disabled={managementBusy || !!snapshot.damaged} onChanged={() => setPrivateDataRevision(value => value + 1)} />
      {remove === item.manifest.id && <div className="executable-plugin-confirm" role="alert"><p>移除“{item.manifest.name}”？已生成的消息和文件会保留。</p><div className="executable-plugin-buttons">
        <button type="button" disabled={managementBusy} onClick={() => void perform({ kind: "remove", id: item.manifest.id, revision: snapshot.revision }, "插件已移除。")}>确认移除执行插件</button>
        <button type="button" disabled={managementBusy} onClick={() => setRemove(undefined)}>取消移除</button></div></div>}
    </article>)}</div>
  </section>;
}
