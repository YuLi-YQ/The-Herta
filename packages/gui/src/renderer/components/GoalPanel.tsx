import type { GoalAction, GoalFailure, GoalReply, GoalView } from "@herta/core";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useHertaBridge } from "../context/HertaBridgeContext.js";
import { Icon } from "./Icon.js";
import { formatStamp } from "./Sidebar/session-markdown.js";
import "../styles/goal.css";

const FAILURES: Record<GoalFailure, string> = {
  no_target: "原来的任务或聊天已关闭，请重新打开后再试。",
  busy: "黑塔正在回复，结束后可修改目标。",
  conflict: "目标已更新，已读取最新记录。你的草稿仍保留，请检查后再保存。",
  damaged: "目标记录无法读取。原数据仍保留，恢复前不会发送目标。",
  storage: "目标没有保存，草稿仍在这里，请稍后重试。",
  invalid: "目标内容无效。目标最多 500 字，结果说明最多 2000 字。",
  history_full: "目标历史已达到 1000 条，不能再建立新目标。现有记录仍保留。",
};
const READ_FAILED = "暂时无法读取目标，请重试。";
const INTRO = "进行中的目标会随下一条消息交给黑塔；是否完成，由你确认。";
interface GoalDraft {
  text: string;
  result: string;
}
interface GoalSlot {
  key: string | null;
  view: GoalView | null;
  error: string | null;
  loading: boolean;
}

/** Per-composer goal state. Requests carry a target epoch so A → B → A cannot revive an old reply. */
export function useGoalController(
  scope: "workbench" | "chat",
  targetId: string | null,
  busy: boolean,
  shown = true,
) {
  const { bridge } = useHertaBridge();
  const read =
    scope === "workbench" ? bridge.getSessionGoal : bridge.getChatGoal;
  const write =
    scope === "workbench" ? bridge.updateSessionGoal : bridge.updateChatGoal;
  const available = Boolean(read && write);
  const key = targetId ? `${scope}:${targetId}` : null;
  const epoch = useRef({ key, value: 0 });
  if (epoch.current.key !== key)
    epoch.current = { key, value: epoch.current.value + 1 };
  const current = useRef({ key, busy, shown });
  current.current = { key, busy, shown };
  const serial = useRef(0);
  const mounted = useRef(true);
  const drafts = useRef(new Map<string, GoalDraft>());
  const pending = useRef(new Set<string>());
  const opener = useRef<HTMLElement | null>(null);
  const latestLoad = useRef<() => Promise<void>>(async () => {});
  const [slot, setSlot] = useState<GoalSlot>({
    key,
    view: null,
    error: null,
    loading: false,
  });
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [, redraw] = useState(0);
  const [notice, setNotice] = useState<{ key: string; text: string } | null>(
    null,
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const view = slot.key === key ? slot.view : null;
  const draft = key
    ? (drafts.current.get(key) ?? {
        text: view?.state.active?.text ?? "",
        result: "",
      })
    : { text: "", result: "" };
  const valid = (captured: number, request: number) =>
    mounted.current &&
    epoch.current.value === captured &&
    serial.current === request;
  const load = async () => {
    if (!key || !targetId || !read || pending.current.has(key)) return;
    const captured = epoch.current.value,
      request = ++serial.current;
    setSlot((old) => ({
      key,
      view: old.key === key ? old.view : null,
      error: null,
      loading: true,
    }));
    try {
      const reply = await read(targetId);
      if (!valid(captured, request)) return;
      const next = reply.view ?? null;
      if (!drafts.current.has(key))
        drafts.current.set(key, {
          text: next?.state.active?.text ?? "",
          result: "",
        });
      setSlot({
        key,
        view: next,
        error: reply.ok
          ? null
          : reply.reason === "storage"
            ? READ_FAILED
            : FAILURES[reply.reason],
        loading: false,
      });
    } catch {
      if (valid(captured, request))
        setSlot((old) => ({ ...old, error: READ_FAILED, loading: false }));
    }
  };
  latestLoad.current = load;
  // Only target identity and bridge capability trigger a read; drafts are not overwritten by renders.
  // biome-ignore lint/correctness/useExhaustiveDependencies: load captures this target; async replies are epoch/serial guarded.
  useEffect(() => {
    setNotice(null);
    setSlot({ key, view: null, error: null, loading: false });
    if (available && key) void load();
  }, [key, read, available]);
  const edit = (field: keyof GoalDraft, value: string) => {
    if (!key || pending.current.has(key) || current.current.busy) return;
    drafts.current.set(key, { ...draft, [field]: value });
    setNotice(null);
    redraw((n) => n + 1);
  };
  const open = () => {
    if (!available || !key) return;
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setOpenFor(key);
    void load();
  };
  const close = () => {
    setOpenFor(null);
    const back = opener.current;
    opener.current = null;
    if (shown && current.current.key === key && back?.isConnected)
      back.focus({ preventScroll: true });
  };
  const mutate = async (action: GoalAction) => {
    if (
      !key ||
      !targetId ||
      !write ||
      !view ||
      current.current.busy ||
      pending.current.has(key)
    )
      return;
    const captured = epoch.current.value,
      request = ++serial.current;
    pending.current.add(key);
    redraw((n) => n + 1);
    setNotice(null);
    setSlot((old) => ({ ...old, error: null }));
    let reply: GoalReply;
    try {
      reply = await write(targetId, view.state.revision, action);
    } catch {
      reply = { ok: false, reason: "storage" };
    }
    pending.current.delete(key);
    if (!valid(captured, request)) {
      if (mounted.current) {
        redraw((n) => n + 1);
        // A → B → A while the first A save ran: release its lock, then read current
        // authority instead of applying that old reply over the returned A draft.
        if (current.current.key === key) void latestLoad.current();
      }
      return;
    }
    const next = reply.view ?? view;
    setSlot({
      key,
      view: next,
      error: reply.ok ? null : FAILURES[reply.reason],
      loading: false,
    });
    if (reply.ok) {
      drafts.current.set(key, {
        text: next.state.active?.text ?? "",
        result: "",
      });
      setNotice({
        key,
        text:
          action.type === "set"
            ? "目标已保存。"
            : action.type === "reset"
              ? "原记录已另存，目标记录已重置。"
              : action.status === "done"
                ? "已记录为完成。"
                : "已记录为放弃。",
      });
    }
    redraw((n) => n + 1);
  };
  return {
    available,
    key,
    targetId,
    shown,
    busy,
    view,
    draft,
    edit,
    load,
    mutate,
    open,
    close,
    isOpen: openFor !== null && openFor === key && shown,
    saving: key !== null && pending.current.has(key),
    loading: slot.key === key && slot.loading,
    error: slot.key === key ? slot.error : null,
    notice: notice?.key === key ? notice.text : null,
  };
}
type GoalController = ReturnType<typeof useGoalController>;

/** No empty goal card: only an active goal or an actionable read problem belongs above the composer. */
export function GoalStrip({ goal }: { readonly goal: GoalController }) {
  if (!goal.available || !goal.key) return null;
  const active = goal.view?.state.active;
  if (!active && !goal.view?.damaged && !goal.error) return null;
  return (
    <section className="herta-goal-strip" aria-label="当前目标">
      <span>{active ? "目标" : "目标记录"}</span>
      <p>
        {active?.text ??
          (goal.view?.damaged ? "目标记录需要恢复" : "暂时无法读取目标")}
      </p>
      <button type="button" onClick={goal.open}>
        {active ? "查看目标" : "查看详情"}
      </button>
    </section>
  );
}

export function GoalPanel({ goal }: { readonly goal: GoalController }) {
  const limitId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(20);
  useLayoutEffect(() => {
    const box = dialog.current;
    if (!box) return;
    if (goal.isOpen && !box.open) box.showModal();
    else if (!goal.isOpen && box.open) box.close();
  }, [goal.isOpen]);
  useEffect(() => {
    setResetConfirmed(false);
    setHistoryLimit(20);
    if (goal.isOpen) field.current?.focus({ preventScroll: true });
  }, [goal.isOpen]);
  const textLength = Array.from(goal.draft.text).length;
  const resultLength = Array.from(goal.draft.result).length;
  const locked = goal.busy || goal.saving || goal.loading || !goal.view;
  const history = [...(goal.view?.state.history ?? [])].reverse();
  const active = goal.view?.state.active;
  const changedText =
    active !== null &&
    active !== undefined &&
    goal.draft.text.trim() !== active.text;
  return (
    <dialog
      ref={dialog}
      className="herta-goal"
      aria-label="目标"
      onClose={goal.close}
      onCancel={(e) => {
        if (goal.saving) e.preventDefault();
      }}
    >
      {goal.isOpen && (
        <>
          <header>
            <strong>目标</strong>
            <button
              type="button"
              aria-label="关闭目标"
              disabled={goal.saving}
              onClick={() => dialog.current?.close()}
            >
              <Icon name="close" />
            </button>
          </header>
          <p className="herta-goal-intro">{INTRO}</p>
          {goal.loading && <p role="status">正在读取目标…</p>}
          {goal.error && <p role="alert">{goal.error}</p>}
          {goal.notice && <p role="status">{goal.notice}</p>}
          {goal.view?.damaged ? (
            <section aria-label="恢复目标记录">
              <p>
                无法读取的原数据不会被覆盖。重置会先另存原数据，再从空目标记录开始。
              </p>
              <label className="herta-goal-reset">
                <input
                  type="checkbox"
                  checked={resetConfirmed}
                  disabled={locked}
                  onChange={(e) => setResetConfirmed(e.target.checked)}
                />
                保留原数据并重置目标记录
              </label>
              <button
                type="button"
                disabled={locked || !resetConfirmed}
                onClick={() => void goal.mutate({ type: "reset" })}
              >
                确认重置
              </button>
            </section>
          ) : (
            <>
              <label>
                目标内容
                <textarea
                  ref={field}
                  value={goal.draft.text}
                  readOnly={goal.busy || goal.saving}
                  onChange={(e) => goal.edit("text", e.target.value)}
                  aria-describedby={limitId}
                />
              </label>
              <small id={limitId}>{textLength} / 500 字</small>
              {textLength > 500 && (
                <p role="alert">目标最多 500 字，请缩短后再保存。</p>
              )}
              <div className="herta-goal-actions">
                <button
                  type="button"
                  disabled={
                    locked || !goal.draft.text.trim() || textLength > 500
                  }
                  onClick={() =>
                    void goal.mutate({
                      type: "set",
                      text: goal.draft.text.trim(),
                    })
                  }
                >
                  {active ? "保存修改" : "设置目标"}
                </button>
              </div>
              {active && (
                <section className="herta-goal-ending" aria-label="结束目标">
                  <label>
                    结果说明（可选）
                    <textarea
                      value={goal.draft.result}
                      readOnly={goal.busy || goal.saving}
                      onChange={(e) => goal.edit("result", e.target.value)}
                    />
                  </label>
                  <small>{resultLength} / 2000 字</small>
                  {resultLength > 2000 && (
                    <p role="alert">结果说明最多 2000 字。</p>
                  )}
                  {changedText && (
                    <p role="status">请先保存目标修改，再结束目标。</p>
                  )}
                  <div className="herta-goal-actions">
                    <button
                      type="button"
                      disabled={locked || changedText || resultLength > 2000}
                      onClick={() =>
                        void goal.mutate({
                          type: "end",
                          status: "done",
                          ...(goal.draft.result.trim()
                            ? { result: goal.draft.result.trim() }
                            : {}),
                        })
                      }
                    >
                      标记已完成
                    </button>
                    <button
                      type="button"
                      disabled={locked || changedText || resultLength > 2000}
                      onClick={() =>
                        void goal.mutate({
                          type: "end",
                          status: "dropped",
                          ...(goal.draft.result.trim()
                            ? { result: goal.draft.result.trim() }
                            : {}),
                        })
                      }
                    >
                      放弃目标
                    </button>
                  </div>
                </section>
              )}
            </>
          )}
          {goal.busy && <p role="status">黑塔正在回复，结束后可修改目标。</p>}
          {goal.saving && <p role="status">正在保存目标…</p>}
          {!goal.loading && !goal.view && (
            <button type="button" onClick={() => void goal.load()}>
              重新读取
            </button>
          )}
          {history.length > 0 && (
            <details className="herta-goal-history">
              <summary>已结束的目标 · {history.length}</summary>
              <ol>
                {history.slice(0, historyLimit).map((item) => (
                  <li key={item.revision}>
                    <div>
                      <strong>
                        {item.status === "done" ? "已完成" : "已放弃"}
                      </strong>
                      <time dateTime={item.endedAt}>
                        {item.endedAt ? formatStamp(item.endedAt) : ""}
                      </time>
                    </div>
                    <p>{item.text}</p>
                    {item.result && (
                      <p className="herta-goal-result">{item.result}</p>
                    )}
                  </li>
                ))}
              </ol>
              {historyLimit < history.length && (
                <button
                  type="button"
                  onClick={() => setHistoryLimit((n) => n + 20)}
                >
                  显示更多历史
                </button>
              )}
            </details>
          )}
        </>
      )}
    </dialog>
  );
}
