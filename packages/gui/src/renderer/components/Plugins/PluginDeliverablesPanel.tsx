import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PluginArtifact, PluginOutputOwner, PluginOutputSnapshot, PluginPatchContent, PluginPatchStatus } from "../../../shared/plugin-deliverables.js";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { CodeView } from "../FileViewer/renderers/CodeView.js";
import { RoundFileView } from "../RoundReader.js";
import { Icon } from "../Icon.js";
import "../../styles/plugin-deliverables.css";
import "../../styles/plugin-controlled-view.css";

export interface PluginDeliverablesPanelProps extends PluginOutputOwner {
  open: boolean;
  shown?: boolean;
  draftRevision: number;
  /** Reads the owner's immediate ref, including edits not yet committed by React. */
  getCurrentRevision?: () => number;
  onClose: () => void;
}
const STATUS: Record<PluginPatchStatus, string> = {
  pending: "待应用", applying: "正在处理", applied: "已应用", denied: "已拒绝",
  cancelled: "已取消", conflict: "文件已变化", failed: "应用失败", "needs-review": "需要重新检查",
};
const RETRYABLE = new Set<PluginPatchStatus>(["pending", "denied", "cancelled", "failed"]);
const EMPTY: PluginOutputSnapshot = { artifacts: [], proposals: [], damagedArtifacts: 0, damagedProposals: 0 };
function stamp(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : "时间未知"; }
function size(bytes: number): string { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`; }
function language(artifact: PluginArtifact): string | undefined {
  return artifact.mime === "application/json" ? "json" : artifact.mime === "text/markdown" ? "markdown" : undefined;
}
type Selection = { kind: "artifact" | "patch"; id: string };
type Reading = { kind: "artifact"; artifact: PluginArtifact; content: string } | { kind: "patch"; patch: PluginPatchContent };

/** Owner-level reader. Persisted files outlive the menu/run; no local path or body is sent to main. */
export function PluginDeliverablesPanel({ scope, target, open, shown = true, draftRevision, getCurrentRevision, onClose }: PluginDeliverablesPanelProps) {
  const { bridge } = useHertaBridge(), api = bridge.executablePlugins;
  const visible = open && shown && !!target;
  const [outputs, setOutputs] = useState<PluginOutputSnapshot>(EMPTY), [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<Selection>(), [reading, setReading] = useState<Reading>(), [readingBusy, setReadingBusy] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0), readSequence = useRef(0), operationSequence = useRef(0), busyRef = useRef(false);
  const close = useRef<HTMLButtonElement>(null), opener = useRef<HTMLElement | null>(null), reader = useRef<HTMLElement>(null);
  const current = useRef({ scope, target, visible, draftRevision, getCurrentRevision, onClose });
  current.current = { scope, target, visible, draftRevision, getCurrentRevision, onClose };
  const owner = { scope, target };
  const isCurrent = (token: number, revision: number) => token === generation.current && current.current.visible
    && current.current.scope === scope && current.current.target === target && current.current.draftRevision === revision
    && (current.current.getCurrentRevision?.() ?? revision) === revision;

  useLayoutEffect(() => {
    generation.current++; readSequence.current++; busyRef.current = false;
    setOutputs(EMPTY); setSelection(undefined); setReading(undefined); setReadingBusy(false); setBusy(false); setError(""); setNotice("");
  }, [scope, target, visible, draftRevision, api]);
  useEffect(() => {
    if (!visible) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus({ preventScroll: true });
    return () => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); };
  }, [visible, scope, target]);
  useEffect(() => {
    if (!visible) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229 && !event.defaultPrevented) {
        event.preventDefault(); current.current.onClose();
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [visible]);
  useEffect(() => () => { generation.current++; readSequence.current++; }, []);
  useEffect(() => { if (reading) reader.current?.focus({ preventScroll: false }); }, [reading?.kind, reading?.kind === "artifact" ? reading.artifact.id : reading?.patch.proposal.id]);
  useEffect(() => {
    if (!visible || !api) return;
    const token = generation.current, revision = draftRevision;
    let disposed = false, fetching = false;
    setLoading(true);
    const read = async () => {
      if (fetching || disposed) return;
      fetching = true; const operation = operationSequence.current;
      try {
        const reply = await api({ kind: "outputs-list", scope, target });
        if (disposed || !isCurrent(token, revision) || operation !== operationSequence.current) return;
        if (!reply.ok) { setError(reply.message); return; }
        if (!reply.outputs) { setError("未能读取插件文件，请重试。"); return; }
        setOutputs(reply.outputs);
      } catch { if (!disposed && isCurrent(token, revision) && operation === operationSequence.current) setError("未能读取插件文件，请重试。"); }
      finally { fetching = false; if (!disposed && isCurrent(token, revision)) setLoading(false); }
    };
    void read(); const timer = setInterval(() => void read(), 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [scope, target, visible, draftRevision, api, refresh]);

  async function inspect(next: Selection) {
    if (!api || busyRef.current || !visible) return;
    const token = generation.current, revision = draftRevision, sequence = ++readSequence.current;
    if (!isCurrent(token, revision)) return;
    setSelection(next); setReading(undefined); setReadingBusy(true); setError(""); setNotice("");
    try {
      const reply = await api({ kind: next.kind === "artifact" ? "artifact-read" : "patch-read", ...owner, id: next.id });
      if (!isCurrent(token, revision) || sequence !== readSequence.current) return;
      if (!reply.ok) { setError(reply.message); return; }
      if (next.kind === "artifact" && reply.artifact?.id === next.id && typeof reply.content === "string") {
        setReading({ kind: "artifact", artifact: reply.artifact, content: reply.content });
      } else if (next.kind === "patch" && reply.patch?.proposal.id === next.id) {
        setReading({ kind: "patch", patch: reply.patch });
        const proposal = reply.patch.proposal;
        setOutputs(previous => ({ ...previous, proposals: previous.proposals.map(item => item.id === proposal.id ? proposal : item) }));
      } else setError("文件记录已变化，请重新选择。");
    } catch { if (isCurrent(token, revision) && sequence === readSequence.current) setError("读取失败，请重试。"); }
    finally { if (isCurrent(token, revision) && sequence === readSequence.current) setReadingBusy(false); }
  }
  async function perform(kind: "artifact-save" | "patch-apply" | "patch-cancel", id: string) {
    if (!api || busyRef.current || !visible) return;
    const token = generation.current, revision = draftRevision;
    if (!isCurrent(token, revision)) return;
    // Main still checks the current plugin/grant, owner and file hash before committing.
    if (kind !== "artifact-save" && scope !== "workbench") return;
    operationSequence.current++; busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const reply = await api({ kind, ...owner, id });
      if (!isCurrent(token, revision)) return;
      if (!reply.ok) { setError(reply.message); return; }
      if (kind === "artifact-save") setNotice(reply.saved === true ? "已保存副本。" : "已取消保存，原文件仍保留。");
      else if (kind === "patch-apply") setNotice(reply.applying ? "正在检查并应用修改，请留意提案状态。" : "应用请求已处理，请查看提案状态。");
      else setNotice("已请求取消，请以提案的最终状态为准。");
      if (reply.outputs) setOutputs(reply.outputs);
      else if (kind === "patch-apply" && reply.applying) setOutputs(previous => ({ ...previous, proposals: previous.proposals.map(item => item.id === id ? { ...item, status: "applying" } : item) }));
      if (reply.patch?.proposal.id === id) setReading({ kind: "patch", patch: reply.patch });
      setRefresh(value => value + 1);
    } catch { if (isCurrent(token, revision)) setError(kind === "artifact-save" ? "副本未能保存，请重试。" : "请求未完成，请重新查看提案状态。"); }
    finally { if (isCurrent(token, revision)) { busyRef.current = false; setBusy(false); } }
  }

  if (!visible) return null;
  const selectedPatch = reading?.kind === "patch" ? outputs.proposals.find(item => item.id === reading.patch.proposal.id) : undefined;
  return <aside className="plugin-deliverables" aria-label="插件文件">
    <header className="plugin-deliverables-header"><div><h2>插件文件</h2><span>保存在当前{scope === "chat" ? "聊天" : "任务"}中</span></div>
      <button type="button" ref={close} aria-label="关闭插件文件" onClick={onClose}><Icon name="close" /></button></header>
    <div className="plugin-deliverables-body">
      {!api && <p role="alert">当前版本无法读取插件文件。</p>}
      {error && <p role="alert" className="plugin-deliverables-error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">正在读取…</p>}
      {!!(outputs.damagedArtifacts + outputs.damagedProposals) && <p role="alert">有 {outputs.damagedArtifacts + outputs.damagedProposals} 条记录无法读取，已保留原始数据。</p>}
      {!loading && api && !outputs.artifacts.length && !outputs.proposals.length && !outputs.damagedArtifacts && !outputs.damagedProposals && !error && <p className="plugin-deliverables-muted">这个{scope === "chat" ? "聊天" : "任务"}还没有插件文件。</p>}
      {!!outputs.artifacts.length && <section aria-label="生成文件"><h3>生成文件 <span>{outputs.artifacts.length}</span></h3>
        <ul className="plugin-deliverables-list">{outputs.artifacts.map(item => <li key={item.id}>
          <button type="button" className="plugin-deliverables-item" aria-pressed={selection?.kind === "artifact" && selection.id === item.id} disabled={busy} onClick={() => void inspect({ kind: "artifact", id: item.id })}>
            <Icon name="file" /><span><strong>{item.name}</strong><small>{size(item.bytes)} · {item.producer.name} · {stamp(item.createdAt)}</small></span><span>查看</span></button>
          <button type="button" disabled={busy} aria-label={`保存 ${item.name} 的副本`} onClick={() => void perform("artifact-save", item.id)}>保存副本</button>
        </li>)}</ul></section>}
      {!!outputs.proposals.length && <section aria-label="修改提案"><h3>修改提案 <span>{outputs.proposals.length}</span></h3>
        <ul className="plugin-deliverables-list">{outputs.proposals.map(item => <li key={item.id}>
          <button type="button" className="plugin-deliverables-item" disabled={busy} aria-pressed={selection?.kind === "patch" && selection.id === item.id} onClick={() => void inspect({ kind: "patch", id: item.id })}>
            <Icon name="file" /><span><strong>{item.path}</strong><small>{item.producer.name} · <span className="plugin-deliverables-added">+{item.additions}</span> <span className="plugin-deliverables-removed">−{item.deletions}</span></small></span>
            <span className={`plugin-patch-status is-${item.status}`}>{STATUS[item.status]}</span></button>
        </li>)}</ul></section>}
      {(outputs.artifacts.length > 0 || outputs.proposals.length > 0) && <p className="plugin-deliverables-muted">文件保留不代表插件运行成功；修改提案只有“已应用”才表示写入完成。</p>}
      {readingBusy && <p role="status">正在读取内容…</p>}
      {reading?.kind === "artifact" && <section ref={reader} tabIndex={-1} className="plugin-deliverables-reader" aria-label={`${reading.artifact.name} 的内容`}>
        <h3>{reading.artifact.name}</h3><div className="plugin-controlled-code"><CodeView content={reading.content} truncated={false} language={language(reading.artifact)} /></div>
      </section>}
      {reading?.kind === "patch" && selectedPatch && <section ref={reader} tabIndex={-1} className="plugin-deliverables-reader" aria-label={`${selectedPatch.path} 的修改提案`}>
        <h3>{selectedPatch.path}</h3><p role="status" className={`plugin-patch-status is-${selectedPatch.status}`}>{STATUS[selectedPatch.status]}</p>
        {selectedPatch.message && <p>{selectedPatch.message}</p>}
        <RoundFileView key={selectedPatch.id} content={{ roundId: selectedPatch.runId, fileId: selectedPatch.id, path: selectedPatch.path,
          before: reading.patch.before, after: reading.patch.after, diff: reading.patch.diff,
          sourceLabel: selectedPatch.status === "applied" ? "已应用提案的快照" : "提案快照 · 不代表已写入" }} />
        <div className="plugin-deliverables-buttons">
          {scope === "workbench" && RETRYABLE.has(selectedPatch.status) && <button type="button" disabled={busy || readingBusy} onClick={() => void perform("patch-apply", selectedPatch.id)}>{selectedPatch.status === "pending" ? "申请应用" : "重新申请应用"}</button>}
          {scope === "workbench" && selectedPatch.status === "applying" && <><button type="button" disabled={busy} onClick={() => void perform("patch-cancel", selectedPatch.id)}>取消应用</button><button type="button" onClick={onClose}>返回工作台</button></>}
        </div>
        {(selectedPatch.status === "conflict" || selectedPatch.status === "needs-review") && <p className="plugin-deliverables-muted">请重新运行插件检查当前文件并生成新提案。</p>}
      </section>}
    </div>
  </aside>;
}
