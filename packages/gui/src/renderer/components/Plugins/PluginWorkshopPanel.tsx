import { useEffect, useRef, useState } from "react";
import { reasoningChoices } from "@herta/providers/reasoning";
import { parseExecutablePluginPackage, type ExecutablePluginAction, type ExecutablePluginCapabilityName } from "../../../shared/executable-plugins.js";
import { validatePluginActionInput } from "../../../shared/plugin-runtime.js";
import type { ExecutablePluginSnapshot } from "../../../shared/executable-plugin-management.js";
import type { PluginWorkshopDraft, PluginWorkshopDraftList, PluginWorkshopInstallation, PluginWorkshopJob, PluginWorkshopModel, PluginWorkshopReply, PluginWorkshopRequest, PluginWorkshopTarget } from "../../../shared/plugin-workshop.js";
import type { PluginWorkshopDeletePreview } from "../../../shared/plugin-workshop-deletion.js";
import type { PluginTrialResult } from "../../../shared/plugin-trial.js";
import type { ProviderSettingsView } from "../../../shared/provider-settings-ipc.js";
import { PluginInstallDiff } from "./PluginInstallDiff.js";
import { PermissionChoices, executableCapabilityLabel } from "./PluginPermissionChoices.js";
import { PluginControlledView } from "./PluginControlledView.js";

type Values = Record<string, string | boolean>;
type ModelChoice = PluginWorkshopModel & { key: string; label: string; efforts: readonly string[] };
type Request = (input: PluginWorkshopRequest) => Promise<PluginWorkshopReply>;
const STATES = { "not-run": "尚未试跑", completed: "模拟完成", failed: "试跑失败", cancelled: "已停止", unverified: "外部能力未验证" } as const;
const EFFORTS: Record<string, string> = { none: "关闭", enabled: "开启", low: "轻度", medium: "标准", high: "深度", max: "最高" };
const targetOf = (draft: PluginWorkshopDraft): PluginWorkshopTarget => ({ id: draft.id, revision: draft.revision, contentHash: draft.contentHash });
const keyOf = (model: PluginWorkshopModel) => JSON.stringify([model.providerId, model.modelId, model.providerRevision]);
const codeOf = (draft: PluginWorkshopDraft) => JSON.stringify(draft.package, null, 2);
const initialValues = (action?: ExecutablePluginAction): Values => Object.fromEntries((action?.inputs ?? []).map(input => [input.id, input.type === "boolean" ? input.default ?? false : input.default === undefined ? "" : String(input.default)]));
function actionInput(action: ExecutablePluginAction, values: Values) {
  const value: Record<string, string | number | boolean> = Object.create(null);
  for (const input of action.inputs) {
    const current = values[input.id];
    if (input.type === "boolean") value[input.id] = current === true;
    else if (current !== "" && current !== undefined) value[input.id] = input.type === "number" ? Number(current) : String(current);
    else if (input.required) value[input.id] = "";
  }
  return validatePluginActionInput(action, JSON.stringify(value));
}

export function PluginWorkshopPanel({ request, getProviderSettings, hostRevision, available, disabled, onInstalled, onChanged, onBusyChange, onClose }: {
  request: Request; getProviderSettings(): Promise<ProviderSettingsView>; hostRevision: number;
  available: readonly ExecutablePluginCapabilityName[]; disabled: boolean;
  onInstalled(snapshot: ExecutablePluginSnapshot): void; onChanged(): void; onBusyChange(busy: boolean): void; onClose(): void;
}) {
  const [drafts, setDrafts] = useState<PluginWorkshopDraftList>({ items: [], unreadable: 0 }), [draft, setDraft] = useState<PluginWorkshopDraft>();
  const [models, setModels] = useState<ModelChoice[]>([]), [modelKey, setModelKey] = useState(""), [effort, setEffort] = useState("");
  const [brief, setBrief] = useState(""), [json, setJson] = useState(""), [actionId, setActionId] = useState(""), [values, setValues] = useState<Values>({});
  const [scope, setScope] = useState<"chat" | "workbench">("chat"), [fixtures, setFixtures] = useState("{}");
  const [job, setJob] = useState<PluginWorkshopJob>(), [trial, setTrial] = useState<PluginTrialResult>(), [installation, setInstallation] = useState<PluginWorkshopInstallation>();
  const [grants, setGrants] = useState<ExecutablePluginCapabilityName[]>([]), [deletion, setDeletion] = useState<PluginWorkshopDeletePreview>();
  const [busy, setBusy] = useState(false), [canceling, setCanceling] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [closing, setClosing] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [settingsExpanded, setSettingsExpanded] = useState(false), [resultExpanded, setResultExpanded] = useState(false);
  const alive = useRef(false), epoch = useRef(0), locked = useRef(false), activeJob = useRef<string>(), installToken = useRef<string>(), deleteToken = useRef<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(), listSequence = useRef(0), briefInput = useRef<HTMLTextAreaElement>(null);
  const generatedHere = useRef(new Set<string>());
  const modelTouched = useRef(false);
  const callbacks = useRef({ onBusyChange, onInstalled, onChanged }); callbacks.current = { onBusyChange, onInstalled, onChanged };
  const latestHostRevision = useRef(hostRevision); latestHostRevision.current = hostRevision;
  const selectedModel = models.find(model => model.key === modelKey);
  const model: PluginWorkshopModel | undefined = selectedModel && { providerId: selectedModel.providerId, modelId: selectedModel.modelId, providerRevision: selectedModel.providerRevision, ...(effort ? { reasoningEffort: effort } : {}) };
  const modelChanged = !!draft && (modelKey !== keyOf(draft.model) || effort !== (draft.model.reasoningEffort ?? ""));
  // Existing code remains reviewable/offline-editable when its former model is
  // removed. The saved model is provenance only; generation still needs `model`.
  const saveModel = model ?? (draft && !modelChanged ? draft.model : undefined);
  const dirtyJson = draft ? json !== codeOf(draft) : !!json;
  const dirty = draft ? dirtyJson || brief !== draft.brief || modelChanged : !!brief || !!json;
  const action = draft?.package.manifest.actions.find(item => item.id === actionId);
  const blocked = busy || disabled;

  function activity(value: boolean) { locked.current = value; if (alive.current) setBusy(value); callbacks.current.onBusyChange(value); }
  function discardInstall() { const id = installToken.current; installToken.current = undefined; if (id) void request({ kind: "workshop-discard", previewId: id }).catch(() => {}); }
  function discardDeletion() { const id = deleteToken.current; deleteToken.current = undefined; if (id) void request({ kind: "workshop-delete-discard", previewId: id }).catch(() => {}); }
  function discardLate(reply: PluginWorkshopReply) {
    if (!reply.ok) return;
    if (reply.job?.busy) void request({ kind: "workshop-cancel", jobId: reply.job.id }).catch(() => {});
    if (reply.installation) void request({ kind: "workshop-discard", previewId: reply.installation.preview.id }).catch(() => {});
    if (reply.deletePreview) void request({ kind: "workshop-delete-discard", previewId: reply.deletePreview.id }).catch(() => {});
  }
  async function refreshList() {
    const sequence = ++listSequence.current;
    try { const reply = await request({ kind: "workshop-list" }); if (!alive.current || sequence !== listSequence.current) return;
      if (reply.ok) {
        if (reply.drafts) setDrafts(reply.drafts);
        // A reopened panel may observe a not-yet-closed task. Follow/cancel it,
        // but never apply its old generated draft over this panel's edits.
        if (reply.job?.busy && !locked.current && !activeJob.current) finishJob(reply.job, epoch.current);
      } else setError(reply.message);
    } catch { if (alive.current && sequence === listSequence.current) setError("暂时无法读取制作草稿，已有内容仍保留。"); }
  }
  useEffect(() => {
    alive.current = true; void refreshList(); briefInput.current?.focus({ preventScroll: true });
    void getProviderSettings().then(view => {
      if (!alive.current) return;
      const choices: ModelChoice[] = view.settings.providers.flatMap(provider => provider.models.filter(item =>
        ["text-available", "tools-available"].includes(item.validation.state) && item.validation.providerRevision === provider.revision && item.validation.protocol === provider.protocol)
        .map(item => { const selected = { providerId: provider.id, modelId: item.id, providerRevision: provider.revision };
          return { ...selected, key: keyOf(selected), label: `${item.id} · ${provider.name}`, efforts: reasoningChoices(provider, item.id) }; }));
      setModels(choices); const preferred = view.settings.defaultBindings?.persona;
      const chosen = choices.find(item => item.providerId === preferred?.providerId && item.modelId === preferred.modelId) ?? choices[0];
      if (!modelTouched.current) {
        setModelKey(chosen?.key ?? "");
        setEffort(chosen && preferred?.reasoningEffort && chosen.efforts.includes(preferred.reasoningEffort) ? preferred.reasoningEffort : "");
      }
    }).catch(() => { if (alive.current) setError("暂时无法读取已验证模型，请关闭后重试。"); });
    return () => {
      alive.current = false; epoch.current++; listSequence.current++; clearTimeout(timer.current);
      const id = activeJob.current; activeJob.current = undefined;
      if (id) void request({ kind: "workshop-cancel", jobId: id }).catch(() => {});
      discardInstall(); discardDeletion(); callbacks.current.onBusyChange(false);
    };
  }, [request, getProviderSettings]);
  useEffect(() => { discardInstall(); setInstallation(undefined); setGrants([]); }, [hostRevision]);

  function invalidate() {
    epoch.current++; discardInstall(); discardDeletion(); setInstallation(undefined); setDeletion(undefined); setGrants([]); setTrial(undefined); setJob(undefined); setNotice(""); setClosing(false);
  }
  function loadDraft(next: PluginWorkshopDraft) {
    discardInstall(); discardDeletion(); modelTouched.current = true; setDraft(next); setBrief(next.brief); setJson(codeOf(next)); setModelKey(keyOf(next.model)); setEffort(next.model.reasoningEffort ?? "");
    const first = next.package.manifest.actions[0]; setActionId(first?.id ?? ""); setValues(initialValues(first)); setScope(first?.scope === "workbench" ? "workbench" : "chat");
    setFixtures("{}"); setTrial(undefined); setInstallation(undefined); setDeletion(undefined); setGrants([]); setClosing(false);
  }
  function blank() { if (locked.current) return; invalidate(); setDraft(undefined); setBrief(""); setJson(""); setActionId(""); setValues({}); setError(""); }
  function finishJob(next: PluginWorkshopJob, token: number) {
    if (!alive.current || token !== epoch.current) return;
    setJob(next);
    if (next.busy) { activeJob.current = next.id; activity(true); timer.current = setTimeout(() => void poll(next.id, token), 500); return; }
    activeJob.current = undefined; activity(false); setCanceling(false);
    if (next.status === "completed" && next.draft) {
      if (generatedHere.current.has(next.id)) { loadDraft(next.draft); setNotice("候选已保存。先检查和试跑，再决定是否安装。"); }
      else setNotice("此前生成已保存，可从制作草稿中打开；当前编辑仍保留。");
      callbacks.current.onChanged(); void refreshList();
    }
    generatedHere.current.delete(next.id);
    if (next.trial) setTrial(next.trial);
    if (next.status === "failed") setError(next.message ?? "本次处理未完成，需求和编辑内容仍保留。");
    if (next.status === "cancelled") setNotice("已停止，已有草稿和编辑仍保留。");
  }
  async function poll(id: string, token: number) {
    clearTimeout(timer.current);
    try { const reply = await request({ kind: "workshop-status", jobId: id });
      if (!alive.current || token !== epoch.current || activeJob.current !== id) return;
      if (!reply.ok) { setError(reply.message); return; }
      if (!reply.job || reply.job.id !== id) { setError("未取得当前处理状态，请重新查看或停止。"); return; }
      finishJob(reply.job, token);
    } catch { if (alive.current && token === epoch.current) setError("暂时无法取得处理状态，请重新查看或停止。"); }
  }
  async function operate(input: PluginWorkshopRequest, consume: (reply: Extract<PluginWorkshopReply, { ok: true }>, token: number) => void) {
    if (locked.current || disabled) return;
    const token = ++epoch.current; activity(true); setError(""); setNotice(""); setClosing(false);
    try { const reply = await request(input);
      if (!alive.current || token !== epoch.current) { discardLate(reply); return; }
      if (!reply.ok) { setError(reply.message); return; }
      consume(reply, token);
    } catch { if (alive.current && token === epoch.current) setError("操作未完成，需求和编辑内容仍保留，请核对后重试。"); }
    finally { if (alive.current && token === epoch.current && !activeJob.current) activity(false); }
  }
  function startGeneration() {
    if (!model || !brief.trim() || dirtyJson) return;
    discardInstall(); setInstallation(undefined); setTrial(undefined);
    void operate({ kind: "workshop-generate", target: draft ? targetOf(draft) : null, brief, model }, (reply, token) => {
      if (reply.job) { generatedHere.current.add(reply.job.id); finishJob(reply.job, token); } else setError("未取得生成任务，原稿仍保留。");
    });
  }
  function save() {
    if (!saveModel || !brief.trim()) return;
    try { parseExecutablePluginPackage(json); } catch { setError("候选 JSON 不符合插件格式，请检查清单、操作与源码后再保存。"); return; }
    void operate({ kind: "workshop-save", target: draft ? targetOf(draft) : null, brief, packageJson: json, model: saveModel }, reply => {
      if (!reply.draft) { setError("未取得保存记录，编辑内容仍保留。"); return; }
      loadDraft(reply.draft); setNotice("制作草稿已保存，先前试跑与安装预览已失效。"); callbacks.current.onChanged(); void refreshList();
    });
  }
  function runTrial() {
    if (!draft || !action || dirty) return;
    let inputJson: string; try { inputJson = actionInput(action, values); JSON.parse(fixtures); } catch { setError("请检查动作参数和试跑样本 JSON。"); return; }
    discardInstall(); setInstallation(undefined); setTrial(undefined);
    void operate({ kind: "workshop-trial", target: targetOf(draft), actionId: action.id, scope, inputJson, fixturesJson: fixtures }, (reply, token) => {
      if (reply.job) finishJob(reply.job, token); else setError("未取得试跑任务，请重新检查。");
    });
  }
  async function cancel() {
    const id = activeJob.current, token = epoch.current; if (!id || canceling) return;
    setCanceling(true); clearTimeout(timer.current);
    try { const reply = await request({ kind: "workshop-cancel", jobId: id });
      if (!alive.current || token !== epoch.current || activeJob.current !== id) return;
      if (reply.ok && reply.job?.id === id) finishJob(reply.job, token);
      else { if (!reply.ok) setError(reply.message); timer.current = setTimeout(() => void poll(id, token), 500); }
    } catch { if (alive.current && token === epoch.current) { setError("停止请求未确认，请重新查看处理状态。"); timer.current = setTimeout(() => void poll(id, token), 500); } }
    finally { if (alive.current && token === epoch.current) setCanceling(false); }
  }
  function inspectInstall() {
    if (!draft || dirty) return; const target = targetOf(draft); discardInstall(); setInstallation(undefined); setGrants([]);
    void operate({ kind: "workshop-preview", target, hostRevision }, reply => {
      const next = reply.installation;
      if (!next || next.hostRevision !== latestHostRevision.current || next.target.id !== target.id || next.target.revision !== target.revision || next.target.contentHash !== target.contentHash) {
        discardLate(reply); setError("安装预览已变化，请重新检查。"); return;
      }
      installToken.current = next.preview.id; setSettingsExpanded(false); setResultExpanded(false); setInstallation(next);
    });
  }
  function install() {
    if (!installation || !draft || dirty || installation.hostRevision !== hostRevision || blocked) return;
    setInstalling(true);
    void operate({ kind: "workshop-install", target: installation.target, previewId: installation.preview.id, hostRevision: installation.hostRevision, revision: installation.revision, grants }, reply => {
      if (!reply.snapshot) { setError("未取得安装结果，请刷新插件列表核对，勿直接重试。"); return; }
      discardInstall(); setInstallation(undefined); setGrants([]); setNotice("插件已安装。可在两区快捷操作中使用；启停和历史回退仍在下方插件列表。不会自动运行。"); callbacks.current.onInstalled(reply.snapshot);
    }).finally(() => { if (alive.current) setInstalling(false); });
  }
  function inspectDelete(id: string) {
    discardDeletion(); setDeletion(undefined);
    void operate({ kind: "workshop-delete-preview", id }, reply => {
      if (!reply.deletePreview || reply.deletePreview.draftId !== id) { discardLate(reply); setError("未取得草稿删除预览。"); return; }
      deleteToken.current = reply.deletePreview.id; setDeletion(reply.deletePreview);
    });
  }
  function confirmDelete() {
    if (!deletion?.canConfirm || blocked) return;
    if (!Number.isFinite(Date.parse(deletion.expiresAt)) || Date.parse(deletion.expiresAt) <= Date.now()) { discardDeletion(); setDeletion(undefined); setError("删除预览已过期，请重新检查。"); return; }
    const previewId = deletion.id; deleteToken.current = undefined; setDeletion(undefined);
    discardInstall(); setInstallation(undefined); setTrial(undefined); setGrants([]);
    void operate({ kind: "workshop-delete-confirm", previewId }, reply => {
      if (!reply.deleteResult) { setError("未取得删除结果，请重新查看草稿列表，不会自动重试。"); return; }
      const result = reply.deleteResult;
      if (result.deleted && result.draftId === draft?.id) { setDraft(undefined); setBrief(""); setJson(""); setActionId(""); setTrial(undefined); setJob(undefined); }
      setNotice(`${result.message} 已删除 ${result.deletedFiles} 个文件（${result.deletedBytes.toLocaleString()} B），剩余 ${result.remainingFiles} 个。`);
      callbacks.current.onChanged(); void refreshList();
    });
  }
  function editField(update: () => void) { if (locked.current || disabled) return; invalidate(); update(); }
  const previewTarget = installation?.target;
  return <section className="plugin-workshop executable-plugin-confirm" aria-label="黑塔插件工坊" aria-busy={busy}>
    <header className="executable-plugin-heading"><div><h4>让黑塔制作</h4><p className="executable-plugin-muted">先做一份独立候选，检查后再交给工作台。</p></div>
      <button type="button" disabled={installing} onClick={() => dirty ? setClosing(true) : onClose()}>关闭制作</button></header>
    {closing && <div className="plugin-workshop-warning"><p>当前需求或代码尚未保存，关闭会放弃这些编辑；已保存的草稿仍保留。</p><button type="button" onClick={onClose}>关闭并放弃编辑</button><button type="button" onClick={() => setClosing(false)}>继续编辑</button></div>}
    {error && <p role="alert" className="executable-plugin-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <details><summary>制作草稿 · {drafts.items.length}{drafts.unreadable ? ` · ${drafts.unreadable} 项无法读取` : ""}</summary>
      <div className="executable-plugin-buttons"><button type="button" disabled={blocked || dirty} onClick={blank}>新建制作</button><button type="button" disabled={blocked} onClick={() => void refreshList()}>刷新草稿</button></div>
      <ul className="plugin-workshop-drafts">{drafts.items.map(item => <li key={item.id}><span>{item.name} <small>{item.version}</small></span>
        <button type="button" disabled={blocked || dirty} onClick={() => void operate({ kind: "workshop-get", id: item.id }, reply => { if (reply.draft) { loadDraft(reply.draft); setTrial(reply.trials?.[0]); } else setError("未取得制作草稿。"); })}>打开 {item.name}</button>
        <button type="button" disabled={blocked || dirty} onClick={() => inspectDelete(item.id)}>删除 {item.name}</button></li>)}
        {(drafts.damagedIds ?? []).map(id => <li key={id}><span>无法读取的草稿 {id.slice(0, 8)}</span><button type="button" disabled={blocked || dirty} onClick={() => inspectDelete(id)}>检查删除损坏草稿 {id.slice(0, 8)}</button></li>)}</ul>
      {drafts.unreadable > (drafts.damagedIds?.length ?? 0) && <p className="executable-plugin-muted">另有无法辨认的资料已保留，不会自动删除。</p>}
      {dirty && <p className="executable-plugin-muted">先保存或放弃当前编辑，再切换或删除草稿。</p>}
    </details>
    {deletion && <section className="plugin-workshop-warning" aria-label="删除制作草稿确认"><h5>{deletion.name ?? "损坏的制作草稿"}</h5>
      <p>仅删除这份制作草稿；{deletion.fileCount === null ? "文件范围无法统计" : `${deletion.fileCount} 个文件`}，{deletion.bytes === null ? "逻辑大小无法统计" : `逻辑大小 ${deletion.bytes.toLocaleString()} B`}。已安装插件、聊天、项目和生成文件不受影响。删除后不能恢复。</p>
      {deletion.damaged && <p>内容无法完整读取；确认只针对这份已核验范围的损坏草稿。</p>}{deletion.warning && <p>{deletion.warning}</p>}
      <button type="button" disabled={blocked || !deletion.canConfirm} onClick={confirmDelete}>确认删除制作草稿</button><button type="button" disabled={blocked} onClick={() => { discardDeletion(); setDeletion(undefined); }}>取消删除</button>
    </section>}
    <details className="plugin-workshop-stage" open={!installation || settingsExpanded} onToggle={event => { if (installation) setSettingsExpanded(event.currentTarget.open); }}>
    <summary hidden={!installation}>制作与试跑设置</summary>
    <div className="plugin-workshop-models"><label>制作模型<select aria-label="制作模型" disabled={blocked} value={modelKey} onChange={event => editField(() => { modelTouched.current = true; setModelKey(event.target.value); setEffort(""); })}><option value="">选择已验证模型</option>{models.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
      {!!selectedModel?.efforts.length && <label>思考强度<select disabled={blocked} value={effort} onChange={event => editField(() => setEffort(event.target.value))}><option value="">模型默认</option>{selectedModel.efforts.map(value => <option key={value} value={value}>{EFFORTS[value] ?? value}</option>)}</select></label>}</div>
    {!selectedModel && <p className="executable-plugin-muted">生成需要当前配置中已验证的文本模型；可先到“连接与模型”完成配置。已有候选仍可检查、手动保存和安装。</p>}
    <label>制作要求<textarea ref={briefInput} rows={3} maxLength={16000} disabled={blocked} value={brief} onChange={event => editField(() => setBrief(event.target.value))} placeholder="例如：把输入文字整理成可复制的检查清单" /></label>
    <div className="executable-plugin-buttons"><button type="button" disabled={blocked || !model || !brief.trim() || dirtyJson} onClick={startGeneration}>{draft ? "按要求重新生成" : "生成候选"}</button>
      {dirty && <button type="button" disabled={blocked} onClick={() => { if (draft) { invalidate(); loadDraft(draft); } else blank(); }}>放弃未保存编辑</button>}</div>
    {dirtyJson && <p className="executable-plugin-muted">代码有未保存修改，请先保存或放弃，再重新生成。</p>}
    {job && <div className="plugin-workshop-job" role="status"><span>{job.busy ? job.status === "running" ? job.kind === "generate" ? `黑塔正在构思…已收到 ${job.chars.toLocaleString()} 字符` : "正在隔离试跑…" : "正在收尾，稍等片刻…" : job.kind === "generate" ? job.status === "completed" ? "候选生成完成" : "生成已结束" : "试跑已结束"}</span>
      {job.busy && <><button type="button" disabled={canceling} onClick={() => void cancel()}>{canceling ? "正在停止…" : "停止本次处理"}</button><button type="button" onClick={() => void poll(job.id, epoch.current)}>重新查看状态</button></>}</div>}
    <details className="plugin-workshop-source"><summary>候选 JSON · 可手动编辑或粘贴</summary><label>候选 JSON<textarea rows={10} maxLength={2 * 1024 * 1024} spellCheck={false} disabled={blocked} value={json} onChange={event => editField(() => setJson(event.target.value))} /></label>
      <button type="button" disabled={blocked || !saveModel || !brief.trim() || !json.trim() || !dirty} onClick={save}>检查并保存草稿</button></details>
    {draft && <section className="plugin-workshop-checks" aria-label="检查候选"><h5>{draft.package.manifest.name} · {draft.package.manifest.version}</h5>
      {dirty && <p className="executable-plugin-muted">编辑尚未保存，先前试跑与安装预览已失效。</p>}
      <label>试跑操作<select disabled={blocked || dirty} value={actionId} onChange={event => { const next = draft.package.manifest.actions.find(item => item.id === event.target.value); setActionId(event.target.value); setValues(initialValues(next)); setScope(next?.scope === "workbench" ? "workbench" : "chat"); setTrial(undefined); }}>{draft.package.manifest.actions.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      {action?.scope === "both" && <label>模拟区域<select disabled={blocked || dirty} value={scope} onChange={event => { setScope(event.target.value as "chat" | "workbench"); setTrial(undefined); }}><option value="chat">聊天</option><option value="workbench">工作台</option></select></label>}
      {action?.inputs.map(input => <label key={input.id} className={input.type === "boolean" ? "executable-plugin-check" : undefined}>{input.label}{input.required ? " *" : ""}
        {input.type === "boolean" ? <input type="checkbox" disabled={blocked || dirty} checked={values[input.id] === true} onChange={event => { setValues({ ...values, [input.id]: event.target.checked }); setTrial(undefined); }} />
          : input.type === "select" ? <select disabled={blocked || dirty} value={String(values[input.id] ?? "")} onChange={event => { setValues({ ...values, [input.id]: event.target.value }); setTrial(undefined); }}><option value="">请选择</option>{input.options.map(option => <option key={option}>{option}</option>)}</select>
            : input.type === "number" ? <input type="number" disabled={blocked || dirty} min={input.min} max={input.max} step={input.integer ? 1 : "any"} value={String(values[input.id] ?? "")} onChange={event => { setValues({ ...values, [input.id]: event.target.value }); setTrial(undefined); }} />
              : <textarea rows={2} disabled={blocked || dirty} maxLength={input.maxLength} value={String(values[input.id] ?? "")} onChange={event => { setValues({ ...values, [input.id]: event.target.value }); setTrial(undefined); }} />}</label>)}
      <details><summary>试跑样本 JSON（可选）</summary><p className="executable-plugin-muted">样本只在内存中使用。未提供命令或联网样本时会标记未验证，不会访问真实环境。</p><label>试跑样本 JSON<textarea rows={6} maxLength={512 * 1024} spellCheck={false} disabled={blocked || dirty} value={fixtures} onChange={event => { setFixtures(event.target.value); setTrial(undefined); }} /></label></details>
      <div className="executable-plugin-buttons"><button type="button" disabled={blocked || dirty || !action} onClick={runTrial}>隔离试跑所选操作</button><button type="button" disabled={blocked || dirty} onClick={inspectInstall}>查看差异与安装权限</button></div>
      <p className="executable-plugin-muted">试跑只覆盖所选操作和样本，不验证真实网络、命令或项目；也不会写入日常聊天草稿。</p>
    </section>}
    </details>
    {trial && <details className="plugin-workshop-stage" open={!installation || resultExpanded} onToggle={event => { if (installation) setResultExpanded(event.currentTarget.open); }}>
      <summary hidden={!installation}>试跑结果 · {STATES[trial.outcome]}</summary>
      <section className="plugin-workshop-trial" aria-label="隔离试跑结果"><h5>{STATES[trial.outcome]}</h5><p className="executable-plugin-muted">模拟结果 · 真实外部环境未验证</p>
      {!!trial.unverified.length && <ul>{trial.unverified.map(item => <li key={item.capability}>{executableCapabilityLabel(item.capability)}：{item.reason}</li>)}</ul>}
      {trial.controlledView && <PluginControlledView view={trial.controlledView} disabled disabledReason="试跑视图只读，不执行面板操作。" />}
      <details open={trial.outcome !== "completed"}><summary>试跑记录 · {trial.trace.length} 步</summary><ul>{trial.trace.map((item, index) => <li key={index}>{item.capability ? executableCapabilityLabel(item.capability) : "能力请求"} · {item.state === "completed" ? "模拟完成" : item.state === "rejected" ? "已拒绝" : "已请求"}{item.code ? ` · ${item.code}` : ""}</li>)}</ul>{trial.logs.map((item, index) => <p className={item.level === "error" ? "executable-plugin-error" : undefined} key={index}>{item.message}</p>)}</details>
      <details><summary>查看模拟输出</summary><pre className="executable-plugin-output">{trial.runtimeResult.ok ? trial.runtimeResult.valueJson : trial.runtimeResult.code}</pre>{trial.draftProposal && <pre className="executable-plugin-output">{trial.draftProposal}</pre>}{trial.artifacts.map(item => <p key={item.id}>{item.name} · {item.bytes} B · 仅模拟文件</p>)}{trial.proposals.map(item => <p key={item.id}>{item.path} · 仅模拟修改提案</p>)}</details>
    </section></details>}
    {installation && draft && previewTarget?.id === draft.id && <section className="plugin-workshop-install" aria-label="制作候选安装确认"><PluginInstallDiff preview={installation.preview} />
      <details open><summary>各操作的试跑情况</summary><ul>{installation.actions.map(item => <li key={item.actionId}>{draft.package.manifest.actions.find(action => action.id === item.actionId)?.title ?? item.actionId}：{STATES[item.state]}</li>)}</ul></details>
      <p className="executable-plugin-muted">可以跳过试跑再明确安装；未试跑和模拟通过都不代表真实业务已验证。</p>
      <PermissionChoices capabilities={installation.preview.manifest.capabilities} selected={grants} available={available} disabled={blocked || dirty} onChange={setGrants} />
      <div className="executable-plugin-buttons"><button type="button" disabled={blocked || dirty || installation.preview.identical} onClick={install}>{installation.preview.identical ? "已是相同内容" : installation.preview.existing ? "确认更新此候选" : "确认安装此候选"}</button><button type="button" disabled={blocked} onClick={() => { discardInstall(); setInstallation(undefined); }}>取消安装预览</button></div>
    </section>}
  </section>;
}
