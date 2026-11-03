import type { PlanAction, PlanFailure, PlanReply, PlanView } from "@herta/core";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useHertaBridge } from "../context/HertaBridgeContext.js";
import { FullAccessConfirmation } from "./FullAccessConfirmation.js";
import { Icon } from "./Icon.js";
import { formatStamp } from "./Sidebar/session-markdown.js";
import "../styles/plan.css";

const FAILURES: Record<PlanFailure, string> = {
  no_target: "原来的任务已关闭，请重新打开后再试。",
  busy: "本轮仍在进行，结束后可修改计划模式。",
  conflict: "计划已更新，已读取最新记录。你的修改仍保留，请检查后再保存。",
  damaged: "计划记录无法读取，当前保持只读。请先恢复记录。",
  storage: "计划操作没有保存，当前状态与草稿仍保留，请稍后重试。",
  invalid: "计划内容无效，最多 32000 字。",
  confirmation_required: "退出后需要恢复完全访问，请先确认。",
  history_full: "计划修订已达到 100 条上限，现有记录仍保留。",
  unavailable: "当前任务暂时不能使用计划模式。",
};
const READ_FAILED = "暂时无法读取计划，权限暂保持只读，请重试。";
const UPDATED = "计划已更新，你尚未保存的修改仍保留，请检查后再保存。";
const MODE_WORDS = {
  "read-only": "只读 / 讨论",
  "workspace-edit": "工作区编辑",
  "full-access": "完全访问",
};
interface Draft {
  text: string;
  dirty: boolean;
}
interface Slot {
  key: string | null;
  view: PlanView | null;
  loading: boolean;
  error: string | null;
}
interface ExitIntent {
  key: string;
  revision: number;
  apply: ((text: string) => boolean) | null;
  closeAfter: boolean;
}

/** Workbench-only plan state. Loading/uncertain state cannot unlock the permission selector. */
export function usePlanController(
  targetId: string | null,
  busy: boolean,
  shown: boolean,
  onChanged: () => void | Promise<void>,
  captureApply: (targetId: string) => (text: string) => boolean,
) {
  const { bridge } = useHertaBridge();
  const read = bridge.getSessionPlan,
    write = bridge.updateSessionPlan;
  const available = Boolean(read && write),
    key = targetId;
  const epoch = useRef({ key, value: 0 });
  if (epoch.current.key !== key)
    epoch.current = { key, value: epoch.current.value + 1 };
  const current = useRef({ key, busy, shown, onChanged, captureApply });
  current.current = { key, busy, shown, onChanged, captureApply };
  const mounted = useRef(true),
    serial = useRef(0),
    drafts = useRef(new Map<string, Draft>());
  const pending = useRef(new Set<string>()),
    opener = useRef<HTMLElement | null>(null);
  const latestLoad = useRef<() => Promise<PlanReply | undefined>>(
    async () => undefined,
  );
  const [slot, setSlot] = useState<Slot>({
    key,
    view: null,
    loading: false,
    error: null,
  });
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ExitIntent | null>(null);
  const [notice, setNotice] = useState<{
    key: string;
    text: string;
    kind: "success" | "status" | "detail";
  } | null>(null);
  const [, redraw] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const view = slot.key === key ? slot.view : null;
  const draft = key
    ? (drafts.current.get(key) ?? {
        text: view?.state.plan?.text ?? "",
        dirty: false,
      })
    : { text: "", dirty: false };
  const valid = (capture: number, request: number) =>
    mounted.current &&
    epoch.current.value === capture &&
    serial.current === request;
  const acceptDraft = (target: string, next: PlanView, force = false) => {
    const existing = drafts.current.get(target);
    if (force || !existing?.dirty)
      drafts.current.set(target, {
        text: next.state.plan?.text ?? "",
        dirty: false,
      });
  };
  const load = async (): Promise<PlanReply | undefined> => {
    if (!key || !read || pending.current.has(key)) return;
    const capture = epoch.current.value,
      request = ++serial.current;
    setSlot((old) => ({
      key,
      view: old.key === key ? old.view : null,
      loading: true,
      error: null,
    }));
    try {
      const reply = await read(key);
      if (!valid(capture, request)) return;
      // A failed read may carry an old view; it cannot establish permission to edit.
      const next = reply.ok ? reply.view : null;
      if (next) {
        if (
          drafts.current.get(key)?.dirty &&
          view?.state.revision !== next.state.revision
        )
          setNotice({ key, text: UPDATED, kind: "detail" });
        acceptDraft(key, next);
      }
      setSlot({
        key,
        view: next,
        loading: false,
        error: reply.ok
          ? null
          : reply.reason === "storage"
            ? READ_FAILED
            : FAILURES[reply.reason],
      });
      return reply;
    } catch {
      if (valid(capture, request))
        setSlot({ key, view: null, loading: false, error: READ_FAILED });
    }
  };
  latestLoad.current = load;
  // A finished turn may have captured a new model plan; dirty local edits are never replaced.
  // biome-ignore lint/correctness/useExhaustiveDependencies: target/turn edges drive the read; async work has epoch/serial guards.
  useEffect(() => {
    setConfirmation(null);
    setNotice(null);
    if (slot.key !== key)
      setSlot({ key, view: null, loading: false, error: null });
    if (available && key && !busy) void load();
  }, [key, read, available, busy]);
  const rememberOpener = () => {
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  };
  const open = () => {
    if (!available || !key) return;
    rememberOpener();
    setOpenFor(key);
    void load();
  };
  const close = () => {
    setOpenFor(null);
    setConfirmation(null);
    setNotice((previous) => (previous?.kind === "success" ? null : previous));
    const back = opener.current;
    opener.current = null;
    if (shown && current.current.key === key && back?.isConnected)
      back.focus({ preventScroll: true });
  };
  const edit = (text: string) => {
    if (!key || pending.current.has(key) || current.current.busy) return;
    drafts.current.set(key, {
      text,
      dirty: text !== (view?.state.plan?.text ?? ""),
    });
    setNotice(null);
    setConfirmation(null);
    redraw((n) => n + 1);
  };
  const perform = async (
    action: PlanAction,
    apply: ((text: string) => boolean) | null = null,
    authority = view,
    closeAfter = false,
  ) => {
    if (
      !key ||
      !write ||
      !authority ||
      current.current.busy ||
      pending.current.has(key)
    )
      return;
    if (
      apply &&
      (drafts.current.get(key)?.dirty || !authority.state.plan?.text)
    )
      return;
    const capture = epoch.current.value,
      request = ++serial.current;
    pending.current.add(key);
    redraw((n) => n + 1);
    setNotice(null);
    setConfirmation(null);
    setSlot((old) => ({ ...old, error: null }));
    let reply: PlanReply;
    try {
      reply = await write(key, authority.state.revision, action);
    } catch {
      reply = { ok: false, reason: "storage" };
    }
    pending.current.delete(key);
    if (!valid(capture, request)) {
      if (mounted.current) {
        redraw((n) => n + 1);
        if (current.current.key === key) void latestLoad.current();
      }
      return;
    }
    const next = reply.view ?? authority;
    setSlot({
      key,
      view: next,
      loading: false,
      error: reply.ok ? null : FAILURES[reply.reason],
    });
    if (!reply.ok) {
      if (reply.reason === "confirmation_required") {
        setOpenFor(key);
        setConfirmation({
          key,
          revision: next.state.revision,
          apply,
          closeAfter,
        });
      }
      redraw((n) => n + 1);
      return;
    }
    acceptDraft(key, next, action.type === "save" || action.type === "reset");
    setNotice(
      action.type === "enter"
        ? null
        : {
            key,
            kind: action.type === "save" ? "success" : "status",
            text:
              action.type === "save"
                ? next.state.active
                  ? "计划模式中 · 只读 · 已保存"
                  : "计划已保存。"
                : action.type === "reset"
                  ? "原记录已另存，当前保持计划模式与只读权限。"
                  : `已退出计划模式。${reply.restoredMode ? `当前权限：${MODE_WORDS[reply.restoredMode]}。` : ""}`,
          },
    );
    void current.current.onChanged();
    if (action.type === "enter") setOpenFor(key);
    if (apply && next.state.plan?.text) {
      if (apply(next.state.plan.text)) close();
      else
        setNotice({
          key,
          kind: "status",
          text: `已退出计划模式。${reply.restoredMode ? `当前权限：${MODE_WORDS[reply.restoredMode]}。` : ""}草稿已变化，未放入计划；请检查后再点“放入草稿”。`,
        });
    } else if (closeAfter && action.type === "exit") close();
    redraw((n) => n + 1);
  };
  const toggle = async () => {
    if (!available || !key || current.current.busy || pending.current.has(key))
      return;
    rememberOpener();
    setOpenFor(key);
    const capture = epoch.current.value;
    const reply = await load();
    if (!reply?.ok || !valid(capture, serial.current) || !reply.view) return;
    if (reply.view.damaged) return;
    await perform(
      { type: reply.view.state.active ? "exit" : "enter" },
      null,
      reply.view,
      reply.view.state.active,
    );
  };
  const confirmExit = () => {
    if (!confirmation || confirmation.key !== key || !view) return;
    if (confirmation.revision !== view.state.revision) {
      setConfirmation(null);
      setSlot((old) => ({ ...old, error: FAILURES.conflict }));
      return;
    }
    void perform(
      { type: "exit", confirmFullAccess: true },
      confirmation.apply,
      view,
      confirmation.closeAfter,
    );
  };
  const apply = async () => {
    if (
      !key ||
      current.current.busy ||
      pending.current.has(key) ||
      drafts.current.get(key)?.dirty
    )
      return;
    const capture = epoch.current.value;
    // Capture the composer's intent before reading or waiting for elevated permission.
    const insert = current.current.captureApply(key);
    const reply = await load();
    if (
      !reply?.ok ||
      !valid(capture, serial.current) ||
      reply.view.damaged ||
      !reply.view.state.plan?.text
    )
      return;
    if (reply.view.state.active)
      await perform({ type: "exit" }, insert, reply.view);
    else if (!reply.view.locked) {
      if (insert(reply.view.state.plan.text)) close();
      else
        setNotice({
          key,
          kind: "detail",
          text: "草稿已变化，未放入计划；请检查后再点“放入草稿”。",
        });
    }
  };
  return {
    available,
    key,
    busy,
    shown,
    view,
    draft,
    edit,
    open,
    close,
    toggle,
    load,
    save: () => perform({ type: "save", text: draft.text }),
    enter: () => perform({ type: "enter" }),
    exit: () => perform({ type: "exit" }),
    apply,
    reset: () => perform({ type: "reset" }),
    confirmExit,
    cancelConfirmation: () => {
      setConfirmation(null);
      setSlot((old) => ({ ...old, error: null }));
    },
    confirming: confirmation?.key === key,
    isOpen: key !== null && openFor === key && shown,
    saving: key !== null && pending.current.has(key),
    loading: slot.key === key && slot.loading,
    locked: Boolean(
      available &&
        key &&
        (slot.key !== key || slot.loading || !view || view.locked),
    ),
    error: slot.key === key ? slot.error : null,
    notice: notice?.key === key ? notice.text : null,
    noticeKind: notice?.key === key ? notice.kind : null,
  };
}
type Controller = ReturnType<typeof usePlanController>;
export function PlanStrip({ plan }: { readonly plan: Controller }) {
  if (
    !plan.available ||
    !plan.key ||
    (!plan.locked && !plan.view?.state.plan && !plan.error)
  )
    return null;
  return (
    <section className="herta-plan-strip" aria-label="计划状态">
      <strong>
        {plan.view?.damaged
          ? "计划记录需要恢复 · 只读"
          : plan.locked
            ? plan.view?.state.active
              ? "计划模式中 · 只读"
              : "计划状态待确认 · 只读"
            : "已保存计划"}
      </strong>
      <button type="button" onClick={plan.open}>
        查看计划
      </button>
    </section>
  );
}
export function PlanPanel({ plan }: { readonly plan: Controller }) {
  const dialog = useRef<HTMLDialogElement>(null),
    field = useRef<HTMLTextAreaElement>(null);
  const textId = useId();
  const [resetConfirmed, setResetConfirmed] = useState(false),
    [historyCount, setHistoryCount] = useState(10);
  useLayoutEffect(() => {
    const box = dialog.current;
    if (!box) return;
    if (plan.isOpen && !box.open) box.showModal();
    else if (!plan.isOpen && box.open) box.close();
  }, [plan.isOpen]);
  useEffect(() => {
    setResetConfirmed(false);
    setHistoryCount(10);
    if (plan.isOpen) field.current?.focus({ preventScroll: true });
  }, [plan.isOpen, plan.key]);
  const count = Array.from(plan.draft.text).length;
  const disabled = plan.busy || plan.saving || plan.loading || !plan.view;
  const content = plan.view?.state.plan;
  const history = [...(plan.view?.state.history ?? [])].reverse();
  return (
    <dialog
      ref={dialog}
      className="herta-plan"
      aria-label="计划"
      onClose={plan.close}
      onCancel={(e) => {
        if (plan.saving) e.preventDefault();
      }}
    >
      {plan.isOpen && (
        <>
          <header>
            <strong>计划</strong>
            <button
              type="button"
              aria-label="关闭计划"
              disabled={plan.saving}
              onClick={() => dialog.current?.close()}
            >
              <Icon name="close" />
            </button>
          </header>
          <p>计划时只读；放入草稿会退出计划模式，再由你发送。</p>
          {plan.loading && <p role="status">正在读取计划…</p>}
          {plan.error && <p role="alert">{plan.error}</p>}
          {plan.noticeKind === "detail" && plan.notice && (
            <p role="status">{plan.notice}</p>
          )}
          {plan.view?.saveError && (
            <p role="alert">
              本轮建议没有保存为计划，原计划仍保留；请检查后手动保存。
            </p>
          )}
          {plan.view?.damaged ? (
            <section aria-label="恢复计划记录">
              <p>
                原数据会先另存。恢复后仍保持计划模式和只读权限；需要做事时再明确退出。
              </p>
              <label className="herta-plan-reset">
                <input
                  type="checkbox"
                  checked={resetConfirmed}
                  disabled={disabled}
                  onChange={(e) => setResetConfirmed(e.target.checked)}
                />
                保留原数据并重置计划记录
              </label>
              <button
                type="button"
                disabled={disabled || !resetConfirmed}
                onClick={() => void plan.reset()}
              >
                确认重置
              </button>
            </section>
          ) : (
            <>
              {plan.view && !plan.loading && (
                <p role="status">
                  {plan.noticeKind && plan.noticeKind !== "detail"
                    ? plan.notice
                    : plan.view.state.active
                      ? "计划模式中 · 只读"
                      : "当前未处于计划模式"}
                </p>
              )}
              {content && (
                <small>
                  {content.source === "model" ? "黑塔建议" : "手动修订"} ·{" "}
                  {formatStamp(content.updatedAt)}
                </small>
              )}
              <label>
                计划内容
                <textarea
                  ref={field}
                  aria-describedby={textId}
                  value={plan.draft.text}
                  readOnly={disabled || plan.confirming}
                  onChange={(e) => plan.edit(e.target.value)}
                />
              </label>
              <small id={textId}>{count} / 32000 字</small>
              {count > 32000 && (
                <p role="alert">计划最多 32000 字，请缩短后再保存。</p>
              )}
              <div className="herta-plan-actions">
                <button
                  type="button"
                  disabled={
                    disabled ||
                    plan.confirming ||
                    !plan.draft.text.trim() ||
                    count > 32000
                  }
                  onClick={() => void plan.save()}
                >
                  保存计划
                </button>
              </div>
              {plan.draft.dirty && <small>保存修改后，即可放入草稿。</small>}
              <div className="herta-plan-actions">
                {plan.view?.state.active ? (
                  <button
                    type="button"
                    disabled={disabled || plan.confirming}
                    onClick={() => void plan.exit()}
                  >
                    退出计划模式
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={disabled || plan.confirming}
                    onClick={() => void plan.enter()}
                  >
                    进入计划模式
                  </button>
                )}
                <button
                  type="button"
                  disabled={
                    disabled ||
                    plan.confirming ||
                    plan.draft.dirty ||
                    !content?.text
                  }
                  onClick={() => void plan.apply()}
                >
                  放入草稿
                </button>
              </div>
            </>
          )}
          {plan.confirming && (
            <FullAccessConfirmation
              disabled={disabled}
              onConfirm={plan.confirmExit}
              onCancel={plan.cancelConfirmation}
            />
          )}
          {plan.busy && <p role="status">本轮仍在进行，结束后可修改计划。</p>}
          {plan.saving && <p role="status">正在保存计划状态…</p>}
          {!plan.loading && !plan.view && (
            <button type="button" onClick={() => void plan.load()}>
              重新读取
            </button>
          )}
          {history.length > 0 && (
            <details className="herta-plan-history">
              <summary>此前修订 · {history.length}</summary>
              {history.slice(0, historyCount).map((item) => (
                <article key={item.revision}>
                  <small>
                    {item.source === "model" ? "黑塔建议" : "手动修订"} ·{" "}
                    {formatStamp(item.updatedAt)}
                  </small>
                  <pre>{item.text}</pre>
                </article>
              ))}
              {historyCount < history.length && (
                <button
                  type="button"
                  onClick={() => setHistoryCount((n) => n + 10)}
                >
                  显示更多修订
                </button>
              )}
            </details>
          )}
        </>
      )}
    </dialog>
  );
}
