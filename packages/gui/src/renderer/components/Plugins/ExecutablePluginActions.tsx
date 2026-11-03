import { useEffect, useRef, useState } from "react";
import type { ExecutablePluginAction, ExecutablePluginCapabilityName, ExecutablePluginInput } from "../../../shared/executable-plugins.js";
import type { ExecutablePluginRunView, InstalledExecutablePlugin } from "../../../shared/executable-plugin-management.js";
import { validatePluginActionInput, type PluginRuntimeFaultCode } from "../../../shared/plugin-runtime.js";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { executableCapabilityLabel } from "./ExecutablePluginSettings.js";
import { PluginControlledView } from "./PluginControlledView.js";
import "../../styles/executable-plugins.css";

const FAULT_LABELS: Record<PluginRuntimeFaultCode, string> = {
  "invalid-input": "参数不完整或格式不正确，请检查后重试。", "invalid-package": "插件文件无法读取，请重新安装。",
  "missing-export": "插件缺少此操作的实现。", "module-denied": "插件引用了不允许读取的代码文件。", "guest-error": "插件未能完成这次操作。",
  "resource-limit": "插件超出了运行限额，已停止。", timeout: "插件处理超时，已停止。", cancelled: "已停止运行。", revoked: "插件、权限或对话已变化，请重新运行。",
  "capability-denied": "此操作未获得所需权限，或此版本暂不支持。", "invalid-message": "插件返回的结果格式不正确。",
  "runner-unavailable": "插件运行环境暂不可用，请重启后重试。", "runner-crashed": "插件运行中断，现有草稿不受影响。", "host-error": "插件操作未完成，请重试。", busy: "已有插件正在运行，请稍后再试。",
};
type Choice = { plugin: InstalledExecutablePlugin; action: ExecutablePluginAction; key: string };
type Source = { scope: "chat" | "workbench"; target: string; draft: string; draftRevision: number };
type Values = Record<string, string | boolean>;
type ViewOrigin = {
  sourceRun: ExecutablePluginRunView; sourceKey: string; sourceValues: Values;
  viewId: string; viewRevision: number; buttonId: string; consumed: boolean;
};
export interface ExecutablePluginActionsProps {
  scope: "chat" | "workbench"; target: string; draft: string; draftRevision?: number; disabled?: boolean; onInsert: (text: string, expectedRevision?: number) => void | boolean;
  onOpenChange?: (opened: boolean) => void;
  onOpenOutputs?: () => void;
  /** Synchronous run lifecycle, so a host approval can take focus without cancelling the run. */
  onBusyChange?: (running: boolean) => void;
}
function initialValues(action: ExecutablePluginAction): Values {
  return Object.fromEntries(action.inputs.map(input => [input.id, input.type === "boolean" ? input.default ?? false : input.default === undefined ? "" : String(input.default)]));
}
function viewValues(action: ExecutablePluginAction, json: string): Values {
  const parsed = JSON.parse(validatePluginActionInput(action, json)) as Record<string, string | number | boolean>;
  return Object.fromEntries(action.inputs.map(input => [input.id,
    input.type === "boolean" ? parsed[input.id] === true : parsed[input.id] === undefined ? "" : String(parsed[input.id]),
  ]));
}
function inputJson(action: ExecutablePluginAction, values: Values): string {
  const result: Record<string, string | number | boolean> = Object.create(null);
  for (const input of action.inputs) {
    const value = values[input.id];
    if (input.type === "boolean") result[input.id] = value === true;
    else if (value !== "" && value !== undefined) result[input.id] = input.type === "number" ? Number(value) : String(value);
    else if (input.required) result[input.id] = "";
  }
  return validatePluginActionInput(action, JSON.stringify(result));
}
function resultText(run: ExecutablePluginRunView | undefined): string {
  if (!run?.result?.ok) return "";
  try {
    const value: unknown = JSON.parse(run.result.valueJson);
    if (value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch { return ""; }
}
/** File receipts and controlled views are output, not implicit conversation drafts. */
function draftText(run: ExecutablePluginRunView | undefined): string {
  return run?.draftProposal ?? (run?.controlledView || run?.artifacts?.length || run?.proposals?.length ? "" : resultText(run));
}
function elapsed(run: ExecutablePluginRunView): string {
  const start = Date.parse(run.startedAt), end = run.endedAt ? Date.parse(run.endedAt) : Date.now();
  return Number.isFinite(start) && Number.isFinite(end) ? ` · ${Math.max(0, Math.round((end - start) / 1000))} 秒` : "";
}

/** Explicit action -> preview -> explicit insertion. No plugin result can send a message. */
export function ExecutablePluginActions({ scope, target, draft, draftRevision = 0, disabled = false, onInsert, onOpenChange, onOpenOutputs, onBusyChange }: ExecutablePluginActionsProps) {
  const { bridge } = useHertaBridge(), api = bridge.executablePlugins;
  const [opened, setOpened] = useState(false), [items, setItems] = useState<readonly InstalledExecutablePlugin[]>([]);
  const [available, setAvailable] = useState<readonly ExecutablePluginCapabilityName[]>([]), [selected, setSelected] = useState<string>();
  const [values, setValues] = useState<Values>({}), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [inserting, setInserting] = useState(false);
  const [run, setRun] = useState<ExecutablePluginRunView>(), [error, setError] = useState("");
  const [viewOrigin, setViewOrigin] = useState<ViewOrigin>(), [viewReadOnly, setViewReadOnly] = useState(false), [selectingView, setSelectingView] = useState(false);
  const focusResult = useRef(false);
  const current = useRef({ scope, target, draft, draftRevision, disabled, onInsert });
  current.current = { scope, target, draft, draftRevision, disabled, onInsert };
  const reportOpen = useRef(onOpenChange); reportOpen.current = onOpenChange;
  const reportBusy = useRef(onBusyChange); reportBusy.current = onBusyChange;
  const runningRef = useRef(false);
  const reportRunning = (running: boolean) => { if (runningRef.current !== running) { runningRef.current = running; reportBusy.current?.(running); } };
  const setRunBusy = (running: boolean) => { setBusy(running); reportRunning(running); };
  const generation = useRef(0), busyRef = useRef(false), runId = useRef<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(), toggle = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const choices: Choice[] = items.filter(plugin => plugin.enabled).flatMap(plugin => plugin.manifest.actions
    .filter(action => action.scope === "both" || action.scope === scope).map(action => ({ plugin, action, key: `${plugin.manifest.id}:${action.id}` })));
  const chosen = choices.find(choice => choice.key === selected);

  const cancelId = (id: string) => { void api?.({ kind: "cancel", runId: id }).catch(() => {}); };
  const invalidate = () => {
    generation.current++; clearTimeout(timer.current); timer.current = undefined; busyRef.current = false;
    reportRunning(false);
    focusResult.current = false;
    const id = runId.current; runId.current = undefined; if (id) cancelId(id);
  };
  useEffect(() => {
    invalidate(); setRun(undefined); setRunBusy(false); setInserting(false); setLoading(false); setOpened(false); setSelected(undefined); setError("");
    setViewOrigin(undefined); setViewReadOnly(false); setSelectingView(false);
    reportOpen.current?.(false);
    return invalidate;
  }, [api, scope, target, draft, draftRevision, disabled]);
  useEffect(() => {
    if (!opened || loading) return;
    // This is the popover's current view, not another panel below its old menu.
    // Reset the old view's scroll before focusing; long forms may then scroll
    // their focused field into view normally rather than leaving it offscreen.
    const popover = panel.current?.closest<HTMLElement>(".prompt-action-popover");
    if (popover) popover.scrollTop = 0;
    if (focusResult.current) {
      focusResult.current = false;
      panel.current?.querySelector<HTMLElement>(".plugin-controlled-view")?.focus({ preventScroll: false });
      return;
    }
    panel.current?.querySelector<HTMLElement>(chosen ? "input, select, textarea, .executable-plugin-buttons button" : ".executable-plugin-option:not(:disabled)")?.focus({ preventScroll: false });
  }, [opened, selected, loading, viewOrigin?.sourceRun.id, viewOrigin?.viewRevision, viewOrigin?.buttonId]);
  const isCurrent = (token: number, source: Source): boolean => token === generation.current && !current.current.disabled
    && current.current.scope === source.scope && current.current.target === source.target
    && current.current.draftRevision === source.draftRevision && current.current.draft === source.draft;

  function unavailable(choice: Choice): string {
    const missing = choice.action.capabilities.find(capability => !choice.plugin.grantedCapabilities.some(grant => grant.name === capability));
    if (missing) return `尚未允许：${executableCapabilityLabel(missing)}`;
    const unsupported = choice.action.capabilities.find(capability => !available.includes(capability));
    return unsupported ? `暂不支持：${executableCapabilityLabel(unsupported)}` : "";
  }
  async function show() {
    if (opened) { invalidate(); setOpened(false); reportOpen.current?.(false); setRunBusy(false); setInserting(false); setSelectingView(false); setRun(undefined); setViewOrigin(undefined); setViewReadOnly(false); toggle.current?.focus(); return; }
    if (!api || disabled || !target) return;
    const token = ++generation.current; setOpened(true); reportOpen.current?.(true); setSelected(undefined); setLoading(true); setItems([]); setAvailable([]); setError(""); setRun(undefined);
    setViewOrigin(undefined); setViewReadOnly(false); setSelectingView(false);
    try {
      const reply = await api({ kind: "list" }); if (token !== generation.current) return;
      if (!reply.ok) { setError(reply.message); return; }
      if (!reply.snapshot || reply.snapshot.damaged) { setError("插件列表无法读取，请到设置中处理。"); return; }
      setItems(reply.snapshot.items); setAvailable(reply.availableCapabilities ?? []);
    } catch { if (token === generation.current) setError("未能读取插件，请关闭后重试。"); }
    finally { if (token === generation.current) setLoading(false); }
  }
  function choose(choice: Choice) {
    invalidate(); setSelected(choice.key); setValues(initialValues(choice.action)); setRun(undefined); setError(""); setRunBusy(false);
    setViewOrigin(undefined); setViewReadOnly(false); setSelectingView(false);
  }
  async function poll(id: string, token: number, source: Source) {
    if (!api || !isCurrent(token, source)) return;
    try {
      const reply = await api({ kind: "status", runId: id }); if (!isCurrent(token, source)) return;
      if (!reply.ok) { setError(reply.message); busyRef.current = false; setRunBusy(false); cancelId(id); return; }
      if (!reply.run || reply.run.id !== id || reply.run.scope !== source.scope || reply.run.target !== source.target || reply.run.draftRevision !== source.draftRevision) {
        setError("运行记录已变化，请重新运行插件。"); busyRef.current = false; setRunBusy(false); cancelId(id); return;
      }
      accept(reply.run, token, source);
    } catch {
      if (isCurrent(token, source)) { setError("未能读取运行结果，已请求停止。请重新运行。"); busyRef.current = false; setRunBusy(false); cancelId(id); }
    }
  }
  function accept(next: ExecutablePluginRunView, token: number, source: Source) {
    setRun(next);
    if (next.status === "running") timer.current = setTimeout(() => { timer.current = undefined; void poll(next.id, token, source); }, 350);
    else {
      busyRef.current = false; setRunBusy(false);
      if (next.result && !next.result.ok) setError(FAULT_LABELS[next.result.code]);
    }
  }
  async function start() {
    if (!api || !chosen || disabled || !target || busyRef.current || unavailable(chosen)) return;
    if (viewOrigin?.consumed) { setError("这项结果操作已使用，请返回结果阅读或重新选择插件。"); return; }
    let encoded: string;
    try { encoded = inputJson(chosen.action, values); }
    catch { setError("请检查必填参数和输入范围。"); return; }
    const origin = viewOrigin;
    invalidate(); const token = generation.current, source: Source = { scope, target, draft, draftRevision };
    busyRef.current = true; setRunBusy(true); setRun(undefined); setViewReadOnly(false); setError("");
    try {
      const reply = await api(origin
        ? { kind: "view-action", runId: origin.sourceRun.id, viewId: origin.viewId, viewRevision: origin.viewRevision, buttonId: origin.buttonId, inputJson: encoded, draftRevision }
        : { kind: "run", pluginId: chosen.plugin.manifest.id, contentHash: chosen.plugin.contentHash, actionId: chosen.action.id, scope, target, draftRevision, inputJson: encoded });
      if (!isCurrent(token, source)) { if (reply.ok && reply.run) cancelId(reply.run.id); return; }
      if (!reply.ok) { setError(reply.message); busyRef.current = false; setRunBusy(false); return; }
      if (origin && reply.run) setViewOrigin({ ...origin, consumed: true });
      if (!reply.run || reply.run.scope !== scope || reply.run.target !== target || reply.run.draftRevision !== draftRevision) {
        if (reply.run) cancelId(reply.run.id); setError("未能建立此对话的插件运行，请重试。"); busyRef.current = false; setRunBusy(false); return;
      }
      runId.current = reply.run.id; accept(reply.run, token, source);
    } catch { if (isCurrent(token, source)) { setError("插件未能启动，请重试。"); busyRef.current = false; setRunBusy(false); } }
  }
  function stop() { invalidate(); setRunBusy(false); setRun(undefined); setViewOrigin(origin => origin ? { ...origin, consumed: true } : undefined); setError("已请求停止运行。"); }
  function change(input: ExecutablePluginInput, value: string | boolean) { setValues(previous => ({ ...previous, [input.id]: value })); setRun(undefined); setError(""); }
  async function chooseViewAction(buttonId: string) {
    if (!api || !run?.controlledView || !chosen || run.status !== "completed" || !run.result?.ok || viewReadOnly || busyRef.current || disabled) return;
    const displayed = run, displayedView = run.controlledView, sourceChoice = chosen, sourceValues = { ...values };
    if (!displayedView.actions.some(button => button.id === buttonId)) return;
    const token = generation.current, source: Source = { scope, target, draft, draftRevision };
    busyRef.current = true; setSelectingView(true); setError("");
    try {
      const reply = await api({ kind: "status", runId: displayed.id });
      if (!isCurrent(token, source)) return;
      if (!reply.ok) { setRun(undefined); setError(reply.message); return; }
      const fresh = reply.run;
      if (!fresh || fresh.id !== displayed.id || fresh.scope !== source.scope || fresh.target !== source.target || fresh.draftRevision !== source.draftRevision) {
        setRun(undefined); setError("结果所属的对话已变化，请重新运行插件。"); return;
      }
      if (fresh.status !== "completed" || !fresh.result?.ok || !fresh.controlledView) {
        setRun(undefined); setError("这份插件结果已失效，请重新运行。"); return;
      }
      if (fresh.controlledView.id !== displayedView.id || fresh.controlledView.revision !== displayedView.revision
        || JSON.stringify(fresh.controlledView) !== JSON.stringify(displayedView)) {
        setRun(fresh); setError("结果已更新，请阅读后重新选择操作。"); return;
      }
      const button = fresh.controlledView.actions.find(item => item.id === buttonId);
      const next = button && choices.find(choice => choice.plugin.manifest.id === sourceChoice.plugin.manifest.id && choice.action.id === button.actionId);
      if (!button || !next) { setViewReadOnly(true); setError("此操作不在当前插件中，或不适用于这个会话。"); return; }
      let initial: Values;
      try { initial = viewValues(next.action, button.inputJson); }
      catch { setViewReadOnly(true); setError("结果提供的参数不符合此操作，请重新运行插件。"); return; }
      // Keep the completed source result and the current cancellation handle.
      // Selecting a button only opens the existing host-owned parameter form.
      setViewOrigin({ sourceRun: fresh, sourceKey: sourceChoice.key, sourceValues, viewId: fresh.controlledView.id,
        viewRevision: fresh.controlledView.revision, buttonId, consumed: false });
      setSelected(next.key); setValues(initial); setRun(undefined); setViewReadOnly(false);
    } catch { if (isCurrent(token, source)) setError("未能确认结果，请重试。"); }
    finally { if (token === generation.current) { busyRef.current = false; setSelectingView(false); } }
  }
  function returnToResult() {
    if (!viewOrigin || busyRef.current || run?.status === "running") return;
    generation.current++; clearTimeout(timer.current); timer.current = undefined;
    focusResult.current = true;
    setSelected(viewOrigin.sourceKey); setValues(viewOrigin.sourceValues); setRun(viewOrigin.sourceRun);
    setViewReadOnly(viewOrigin.consumed); setViewOrigin(undefined); setError("");
    // runId intentionally remains the latest run; returning to a reading view
    // must never replace an in-flight/newer run's cancellation handle.
  }
  const controlsBusy = busy || inserting || selectingView;
  const inputLocked = controlsBusy || viewOrigin?.consumed === true;
  const display = resultText(run), proposal = draftText(run);
  const structuredOutput = run?.result?.ok && !/^\s*"/.test(run.result.valueJson);
  const canInsert = run?.status === "completed" && run.result?.ok && !!proposal && proposal.length + (draft ? draft.length + 2 : 0) <= 32000;
  async function insert() {
    if (!api || busyRef.current) return;
    if (!run || !canInsert || current.current.disabled || current.current.target !== run.target || current.current.scope !== run.scope || current.current.draftRevision !== run.draftRevision) {
      setError("对话或草稿已变化，请重新运行插件。"); return;
    }
    const displayed = run, token = generation.current, source: Source = { scope, target, draft, draftRevision };
    busyRef.current = true; setInserting(true); setError("");
    try {
      // A completed preview may outlive an install/grant change. Revalidate on
      // the existing user click, without adding another confirmation step.
      const reply = await api({ kind: "status", runId: displayed.id });
      if (!isCurrent(token, source)) return;
      if (!reply.ok) { setRun(undefined); setError(reply.message); return; }
      const fresh = reply.run;
      if (!fresh || fresh.id !== displayed.id || fresh.scope !== source.scope || fresh.target !== source.target || fresh.draftRevision !== source.draftRevision
        || fresh.status !== "completed" || !fresh.result?.ok) {
        setRun(undefined); setError("运行记录已变化，请重新运行插件。"); return;
      }
      const latestProposal = draftText(fresh);
      if (latestProposal !== proposal || !displayed.result?.ok || fresh.result.valueJson !== displayed.result.valueJson) {
        setRun(fresh); setError("结果已变化，请阅读后再确认插入。"); return;
      }
      const next = current.current.draft ? `${current.current.draft}\n\n${latestProposal}` : latestProposal;
      if (next.length > 32000) { setError("合并后的草稿过长，请先精简。"); return; }
      // The owner checks its immediate edit revision too, covering the gap
      // before React commits a newly edited draft back into these props.
      const inserted = current.current.onInsert(next, source.draftRevision);
      if (token !== generation.current) return;
      if (inserted === false) { setRun(undefined); setError("草稿已变化，请重新运行插件。"); return; }
      invalidate(); setInserting(false); setRun(undefined); setOpened(false); reportOpen.current?.(false); setSelected(undefined); setError("");
    } catch { if (isCurrent(token, source)) setError("草稿未能更新，请重试。"); }
    finally { if (token === generation.current) { busyRef.current = false; setInserting(false); } }
  }
  if (!api) return null;
  return <div className={`executable-plugin-actions${opened ? " is-open" : ""}`}>
    <button type="button" className={opened ? "executable-plugin-back" : "prompt-action-option"} ref={toggle} aria-expanded={opened} disabled={disabled || !target} title={!target ? "先打开一个对话" : undefined} onClick={() => void show()}>
      {opened ? "返回快捷操作" : <>运行插件<small>已安装的小工具</small></>}</button>
    {opened && <div ref={panel} className="executable-plugin-action-panel" aria-label="运行执行插件">
      {loading && <p role="status">正在读取插件…</p>}{error && <p className="executable-plugin-error" role="alert">{error}</p>}
      {!chosen ? <>{!loading && !choices.length && <p className="executable-plugin-muted">暂无可用操作，可在设置中安装并启用执行插件。</p>}
        {choices.map(choice => { const reason = unavailable(choice); return <button type="button" className="executable-plugin-option" key={choice.key} disabled={!!reason || loading}
          onClick={() => choose(choice)}><span>{choice.action.title}<small>{choice.plugin.manifest.name}</small></span>{reason && <small>{reason}</small>}</button>; })}</> : <>
        {viewOrigin && <div className="plugin-view-origin"><button type="button" disabled={controlsBusy || run?.status === "running"} onClick={returnToResult}>返回结果</button>
          <small>{viewOrigin.sourceRun.controlledView?.title}</small></div>}
        <div className="executable-plugin-heading"><h4>{chosen.action.title}</h4><small>{chosen.plugin.manifest.name}</small></div>
        {unavailable(chosen) && <p className="executable-plugin-muted">{unavailable(chosen)}</p>}
        <div className="executable-plugin-fields">{chosen.action.inputs.map(input => <label key={input.id} className={input.type === "boolean" ? "executable-plugin-check" : undefined}>
          {input.type === "boolean" ? <><input type="checkbox" disabled={inputLocked} checked={values[input.id] === true} onChange={event => change(input, event.target.checked)} /><span>{input.label}</span></> : <>
            <span>{input.label}{input.required ? " *" : ""}</span>
            {input.type === "select" ? <select disabled={inputLocked} value={String(values[input.id] ?? "")} onChange={event => change(input, event.target.value)}><option value="">请选择</option>{input.options.map(option => <option key={option}>{option}</option>)}</select>
              : input.type === "number" ? <input type="number" disabled={inputLocked} value={String(values[input.id] ?? "")} min={input.min} max={input.max} step={input.integer ? 1 : "any"} onChange={event => change(input, event.target.value)} />
                : <textarea disabled={inputLocked} value={String(values[input.id] ?? "")} maxLength={input.maxLength} rows={3} onChange={event => change(input, event.target.value)} />}
          </>}
        </label>)}</div>
        <div className="executable-plugin-buttons"><button type="button" disabled={controlsBusy || disabled || viewOrigin?.consumed || !!unavailable(chosen)} onClick={() => void start()}>{busy ? "处理中…" : viewOrigin?.consumed ? "已运行" : "开始运行"}</button>
          {busy && <button type="button" onClick={stop}>停止运行</button>}
          {!viewOrigin && <button type="button" disabled={controlsBusy} onClick={() => { invalidate(); setSelected(undefined); setRun(undefined); setError(""); }}>返回插件列表</button>}</div>
        {run && <section className="executable-plugin-run" aria-label="插件运行结果"><p role="status" className="executable-plugin-meta">{run.status === "running" ? "运行中" : run.status === "completed" ? "已完成" : run.status === "cancelled" ? "已停止" : "未完成"}{elapsed(run)}</p>
          {onOpenOutputs && (!!run.artifacts?.length || !!run.proposals?.length) && <button type="button" disabled={disabled || controlsBusy} onClick={onOpenOutputs}>查看已保存文件与提案</button>}
          {run.progress && run.status === "running" && <div><p>{run.progress.message}</p>{run.progress.value !== undefined && <progress aria-label="插件进度" max={1} value={run.progress.value} />}</div>}
          {!!run.logs.length && <details open={run.status === "failed" ? true : undefined}><summary>处理记录 · {run.logs.length}</summary><ol className="executable-plugin-logs">{run.logs.map((log, index) => <li key={index} className={log.level === "error" ? "executable-plugin-error" : undefined}>{log.message}</li>)}</ol></details>}
          {run.controlledView && <PluginControlledView view={run.controlledView}
            disabled={disabled || controlsBusy || viewReadOnly || run.status !== "completed" || !run.result?.ok}
            disabledReason={viewReadOnly ? "这份结果仅供阅读，请重新运行获取可用操作。" : run.status === "running" ? "运行完成后可选择操作。" : run.status !== "completed" || !run.result?.ok ? "这次运行未完成，结果仅供阅读。" : selectingView ? "正在确认结果…" : undefined}
            onAction={buttonId => void chooseViewAction(buttonId)} />}
          {display && (run.controlledView ? <details><summary>返回数据</summary><pre className={`executable-plugin-output${structuredOutput ? " executable-plugin-code" : ""}`}>{display}</pre></details>
            : <pre className={`executable-plugin-output${structuredOutput ? " executable-plugin-code" : ""}`}>{display}</pre>)}
          {run.draftProposal && run.draftProposal !== display && <div><h5>草稿提案</h5><pre className="executable-plugin-output">{run.draftProposal}</pre></div>}
          {run.status === "completed" && run.result?.ok && !!proposal && <div className="executable-plugin-buttons"><button type="button" disabled={!canInsert || disabled || controlsBusy} onClick={() => void insert()}>{inserting ? "正在确认…" : "追加到草稿"}</button>
            {!canInsert && <small>结果过长，请先复制需要的部分。</small>}</div>}
        </section>}
      </>}
    </div>}
  </div>;
}
