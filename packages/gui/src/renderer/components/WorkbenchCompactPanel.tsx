import type { CompactAction, CompactReply, CompactView } from "@herta/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useHertaBridge } from "../context/HertaBridgeContext.js";
import { Icon } from "./Icon.js";
import { MessageContent } from "./MessageContent.js";
import { formatStamp } from "./Sidebar/session-markdown.js";
import "../styles/compact.css";

const failure = {
  no_target: "原来的任务已关闭，请重新打开后再试。",
  busy: "本轮仍在进行，结束后可安排整理。",
  conflict: "整理状态已更新，请检查后再试。",
  invalid: "当前无法更改整理安排。",
  unavailable: "当前任务暂时无法整理先前记录。",
};
function statusText(view: CompactView) {
  if (view.status === "scheduled") return "下一回合整理先前记录";
  if (view.status === "running") return "正在整理先前记录…";
  if (view.status === "completed") return "先前记录已整理";
  if (view.status === "skipped" && view.reason === "nothing_to_compact")
    return "更早的内容不足，本次无需整理。";
  if (view.status === "failed") {
    if (view.reason === "input_limit")
      return "更早的内容超出整理额度，本次未整理，原记录仍保留。";
    if (view.reason === "storage") return "整理结果未能保存，原记录仍保留。";
    return "本次未能整理，原记录仍保留。";
  }
  if (view.reason === "cancelled") return "已撤销下一回合的整理安排。";
  return view.recap ? "先前记录" : "尚未生成摘要，原消息仍可在对话中查看。";
}
export function useWorkbenchCompact(
  target: string | null,
  busy: boolean,
  shown: boolean,
) {
  const { bridge } = useHertaBridge();
  const read = bridge.getSessionCompact,
    write = bridge.updateSessionCompact;
  const available = Boolean(read && write);
  const epoch = useRef({ target, value: 0 });
  if (epoch.current.target !== target)
    epoch.current = { target, value: epoch.current.value + 1 };
  const current = useRef({ target, busy, shown });
  current.current = { target, busy, shown };
  const mounted = useRef(true),
    sequence = useRef(0),
    pending = useRef(new Set<string>());
  const latestRead = useRef<() => Promise<CompactReply | undefined>>(
    async () => undefined,
  );
  const opener = useRef<HTMLElement | null>(null);
  const [slot, setSlot] = useState<{
    target: string | null;
    view: CompactView | null;
    loading: boolean;
    error: string | null;
    readFailed: boolean;
  }>({ target, view: null, loading: false, error: null, readFailed: false });
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [, redraw] = useState(0);
  const view = slot.target === target ? slot.view : null;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const valid = (capture: number, request: number) =>
    mounted.current &&
    epoch.current.value === capture &&
    sequence.current === request;
  const load = async () => {
    if (!target || !read || pending.current.has(target)) return;
    const capture = epoch.current.value,
      request = ++sequence.current;
    setSlot((old) => ({
      target,
      view: old.target === target ? old.view : null,
      loading: true,
      error: null,
      readFailed: false,
    }));
    try {
      const reply = await read(target);
      if (!valid(capture, request)) return;
      setSlot({
        target,
        view: reply.ok ? reply.view : (reply.view ?? null),
        loading: false,
        error: reply.ok ? null : failure[reply.reason],
        readFailed: !reply.ok,
      });
      return reply;
    } catch {
      if (valid(capture, request))
        setSlot({
          target,
          view: null,
          loading: false,
          error: "暂时无法读取先前记录，请重试。",
          readFailed: true,
        });
    }
  };
  latestRead.current = load;
  useEffect(() => {
    if (available && target && !busy) void load();
  }, [target, busy, available, read]);
  // Follow only an arranged compaction while the turn runs; ordinary turns do not poll.
  useEffect(() => {
    if (
      !shown ||
      !busy ||
      !available ||
      !target ||
      !["scheduled", "running"].includes(view?.status ?? "")
    )
      return;
    void load();
    const timer = setInterval(() => {
      void latestRead.current();
    }, 800);
    return () => clearInterval(timer);
  }, [target, busy, shown, available, view?.status]);
  const open = () => {
    if (!available || !target) return;
    const focused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    opener.current =
      focused
        ?.closest(".prompt-action-picker")
        ?.querySelector<HTMLElement>(":scope > button") ?? focused;
    setOpenFor(target);
    void load();
  };
  const close = () => {
    setOpenFor(null);
    if (
      shown &&
      current.current.target === target &&
      opener.current?.isConnected
    )
      opener.current.focus({ preventScroll: true });
    opener.current = null;
  };
  const update = async (action: CompactAction) => {
    if (
      !target ||
      !write ||
      current.current.busy ||
      pending.current.has(target)
    )
      return;
    const capture = epoch.current.value;
    const authority = await load();
    if (
      !authority?.ok ||
      epoch.current.value !== capture ||
      current.current.busy
    )
      return;
    if (action.type === "schedule" && authority.view.status === "scheduled")
      return;
    const request = ++sequence.current;
    pending.current.add(target);
    redraw((n) => n + 1);
    try {
      const reply = await write(target, authority.view.revision, action);
      if (!valid(capture, request)) return;
      setSlot({
        target,
        view: reply.ok ? reply.view : (reply.view ?? authority.view),
        loading: false,
        error: reply.ok ? null : failure[reply.reason],
        readFailed: false,
      });
    } catch {
      if (valid(capture, request))
        setSlot((old) => ({
          ...old,
          loading: false,
          error: "整理安排未能更新，请稍后重试。",
          readFailed: false,
        }));
    } finally {
      pending.current.delete(target);
      if (mounted.current) {
        redraw((n) => n + 1);
        if (
          epoch.current.value !== capture &&
          current.current.target === target
        )
          void latestRead.current();
      }
    }
  };
  return {
    available,
    view,
    open,
    close,
    load,
    schedule: () => update({ type: "schedule" }),
    cancel: () => update({ type: "cancel" }),
    busy,
    isOpen: Boolean(target && openFor === target && shown),
    saving: Boolean(target && pending.current.has(target)),
    loading: slot.target === target && slot.loading,
    error: slot.target === target ? slot.error : null,
    readFailed: slot.target === target && slot.readFailed,
  };
}
type Compact = ReturnType<typeof useWorkbenchCompact>;
export function CompactStrip({ compact }: { readonly compact: Compact }) {
  if (
    !compact.available ||
    (!compact.error &&
      (!compact.view ||
        (compact.view.status === "idle" &&
          !compact.view.recap &&
          !compact.view.reason)))
  )
    return null;
  return (
    <section className="herta-compact-strip" aria-label="先前记录状态">
      <span>
        {compact.error ? (
          <span role="alert">{compact.error}</span>
        ) : (
          compact.view && statusText(compact.view)
        )}
      </span>
      <div>
        {compact.view?.status === "scheduled" && (
          <button
            type="button"
            disabled={compact.busy || compact.loading || compact.saving}
            onClick={() => void compact.cancel()}
          >
            撤销整理
          </button>
        )}
        <button type="button" onClick={compact.open}>
          查看先前记录
        </button>
      </div>
    </section>
  );
}
export function WorkbenchCompactPanel({
  compact,
}: {
  readonly compact: Compact;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const box = dialog.current;
    if (compact.isOpen && box && !box.open) box.showModal();
    else if (!compact.isOpen && box?.open) box.close();
  }, [compact.isOpen]);
  return (
    <dialog
      ref={dialog}
      className="herta-compact"
      aria-label="先前记录"
      onClose={compact.close}
    >
      {compact.isOpen && (
        <>
          <header>
            <strong>先前记录</strong>
            <button
              type="button"
              aria-label="关闭先前记录"
              onClick={() => dialog.current?.close()}
            >
              <Icon name="close" />
            </button>
          </header>
          {compact.loading && <p role="status">正在读取先前记录…</p>}
          {compact.error && <p role="alert">{compact.error}</p>}
          {!compact.loading && !compact.error && compact.view && (
            <p role="status">{statusText(compact.view)}</p>
          )}
          {compact.view?.status === "scheduled" && (
            <p>
              发送下一条消息时整理；重新打开任务后需重新安排。原消息仍保留。
            </p>
          )}
          {compact.view?.recap ? (
            <>
              <p>这是整理后的摘要，原消息仍在对话中。</p>
              <small>
                覆盖前 {compact.view.recap.boundaryIndex} 条记录（共{" "}
                {compact.view.recordLength} 条） · 生成时间：
                {compact.view.recap.generatedAt
                  ? formatStamp(compact.view.recap.generatedAt)
                  : "未记录"}
              </small>
              <div className="herta-compact-text">
                <MessageContent text={compact.view.recap.text} />
              </div>
            </>
          ) : null}
          <div className="herta-actions">
            {compact.readFailed && (
              <button
                type="button"
                disabled={compact.loading || compact.saving}
                onClick={() => void compact.load()}
              >
                重试读取
              </button>
            )}
            {compact.view?.status === "scheduled" && (
              <button
                type="button"
                disabled={compact.busy || compact.loading || compact.saving}
                onClick={() => void compact.cancel()}
              >
                撤销整理
              </button>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
