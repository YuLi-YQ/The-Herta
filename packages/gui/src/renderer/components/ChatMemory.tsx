import { useRef, useState } from "react";
import type {
  HertaChatAction,
  HertaChatSnapshot,
} from "../../shared/herta-chat.js";

type Action = Extract<HertaChatAction, { type: "memory" }>;
export function ChatMemory({
  memory,
  onManage,
}: {
  memory: HertaChatSnapshot["memory"];
  onManage: (action: Action) => Promise<boolean>;
}) {
  const [text, setText] = useState(""),
    [id, setId] = useState<string>();
  const dialog = useRef<HTMLDialogElement>(null);
  if (!memory) return null;
  return (
    <>
      <button type="button" onClick={() => dialog.current?.showModal()}>
        黑塔的记忆 · {memory.items.length}
      </button>
      <dialog
        ref={dialog}
        aria-label="黑塔的记忆"
        className="herta-chat-memory"
        onClick={(e) => {
          if (e.target === e.currentTarget) dialog.current?.close();
        }}
      >
        <header>
          <strong>黑塔的记忆</strong>
          <button
            type="button"
            aria-label="关闭记忆"
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </header>
        <label>
          <input
            type="checkbox"
            checked={memory.enabled}
            onChange={(e) =>
              void onManage({
                type: "memory",
                operation: "enable",
                enabled: e.target.checked,
              })
            }
          />
          使用记忆与空闲整理
        </label>
        <small>
          {memory.status} · 空闲整理使用默认黑塔模型，会消耗少量 API 用量
        </small>
        <ul>
          {memory.items.map((item) => (
            <li key={item.id}>
              <span>{item.text}</span>
              <small>
                {item.source === "idle" ? "从聊天整理" : "由你确认"}
              </small>
              <button
                type="button"
                onClick={() => {
                  setId(item.id);
                  setText(item.text);
                }}
              >
                修改
              </button>
              <button
                type="button"
                onClick={() =>
                  void onManage({
                    type: "memory",
                    operation: "delete",
                    id: item.id,
                  })
                }
              >
                忘记
              </button>
            </li>
          ))}
        </ul>
        <label>
          {" "}
          {id ? "更正这条记忆" : "告诉黑塔要记住什么"}
          <textarea
            maxLength={500}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={!text.trim()}
          onClick={async () => {
            if (
              await onManage({ type: "memory", operation: "save", id, text })
            ) {
              setText("");
              setId(undefined);
            }
          }}
        >
          保存记忆
        </button>
        {id && (
          <button
            type="button"
            onClick={() => {
              setId(undefined);
              setText("");
            }}
          >
            取消修改
          </button>
        )}
      </dialog>
    </>
  );
}

export function MemoryProposal({
  text,
  items = [],
  onManage,
}: {
  text: string;
  items?: { id: string; text: string }[];
  onManage: (action: Action) => Promise<boolean>;
}) {
  const [saved, setSaved] = useState(false);
  let action: Action;
  try {
    const raw = JSON.parse(text);
    if (
      !raw ||
      !["save", "delete"].includes(raw.operation) ||
      (raw.id !== undefined && typeof raw.id !== "string") ||
      (raw.operation === "save" &&
        (typeof raw.text !== "string" ||
          !raw.text.trim() ||
          raw.text.length > 500)) ||
      (raw.operation === "delete" && !raw.id)
    )
      throw new Error();
    action = {
      type: "memory",
      operation: raw.operation,
      id: raw.id,
      text: raw.text,
    };
  } catch {
    return <p>记忆建议格式不完整，请在“黑塔的记忆”中手动整理。</p>;
  }
  const target = action.id
    ? items.find((item) => item.id === action.id)
    : undefined;
  const stale = Boolean(action.id && !target);
  return (
    <section className="herta-memory-proposal">
      <strong>待确认的记忆更改</strong>
      {target && <p>原记忆：{target.text}</p>}
      <p>{action.operation === "delete" ? "忘记这条记忆" : action.text}</p>
      <button
        type="button"
        disabled={saved || stale}
        onClick={async () => {
          if (await onManage(action)) setSaved(true);
        }}
      >
        {saved
          ? "已保存"
          : stale
            ? "原记忆已不存在"
            : action.operation === "delete"
              ? "确认忘记"
              : "确认记住"}
      </button>
    </section>
  );
}
