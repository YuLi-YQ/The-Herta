import { reasoningChoices } from "@herta/providers/reasoning";
import { useEffect, useRef, useState } from "react";
import {
  chatContextStart,
  validateChatAttachments,
  type ChatAttachment,
  chatFailures,
  chatOutputBudgets,
  defaultChatOutputBudget,
  type HertaChatAction,
  type HertaChatSnapshot,
} from "../../shared/herta-chat.js";
import { useHertaBridge } from "../context/HertaBridgeContext.js";
import { WaitingStatus } from "./WaitingStatus.js";
import { MessageContent } from "./MessageContent.js";
import { MessageTime } from "./MessageTime.js";
import { ChatMemory } from "./ChatMemory.js";
import "../styles/herta-chat.css";

const empty: HertaChatSnapshot = {
  revision: -1,
  activeId: null,
  chats: [],
  messages: [],
  contextStart: 0,
  contextNote: "",
  contextCharacters: 0,
  busy: false,
  error: null,
};
const draftKey = (id: string) => `the-herta.chat-draft.v2.${id}`;
const modelKey = (id: string) => `the-herta.chat-model.v2.${id}`;
function safeError(error: unknown): string {
  const value = String(error);
  return (
    [
      "聊天已切换，请在当前聊天重新发送。",
      "当前模型不支持所选思考强度，请重新选择。",
      "续聊上下文已满，请调整续聊范围或新建聊天；原文仍保留。",
      "保留的内容仍然过长，请选择更少轮次。",
      "名称需为1至80个字符。",
      "聊天数量达到本版上限，回收区仍计入总量。",
      "请先在连接设置中验证所选模型的文本能力。",
      "聊天操作未保存，原记录保持不变。",
      "聊天记录未能保存，消息尚未发送。",
      "请等待回复结束或先停止，再管理聊天。",
    ].find((text) => value.includes(text)) ??
    "操作未完成，请检查连接与模型设置；记录和草稿已保留。"
  );
}
export function HertaChat({
  visible = true,
  settingsOpen = false,
  onSettings,
}: {
  visible?: boolean;
  settingsOpen?: boolean;
  onSettings: () => void;
}) {
  const { bridge } = useHertaBridge();
  const lastActivity = useRef(0);
  const noteActivity = () => {
    if (Date.now() - lastActivity.current < 10000) return;
    lastActivity.current = Date.now();
    void Promise.resolve(bridge.manageHertaChat?.({ type: "activity" })).catch(
      () => {},
    );
  };
  const scroller = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  const [state, setState] = useState<HertaChatSnapshot>(empty);
  const activeRef = useRef<string | null>(null);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  useEffect(() => setAttachments([]), [state.activeId]);
  const [budget, setBudget] = useState<number>(defaultChatOutputBudget);
  const [models, setModels] = useState<
    {
      key: string;
      providerId: string;
      modelId: string;
      label: string;
      efforts: readonly string[];
    }[]
  >([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [selected, setSelected] = useState("");
  const [effort, setEffort] = useState("");
  const efforts = models.find((m) => m.key === selected)?.efforts ?? [];
  const effortLabels: Record<string, string> = {
    none: "关闭思考",
    enabled: "开启思考",
    low: "轻度",
    medium: "中等",
    high: "深度",
    max: "最高",
  };
  useEffect(() => {
    const saved = state.activeId
      ? localStorage.getItem(
          `the-herta.chat-effort.${state.activeId}.${selected}`,
        )
      : null;
    setEffort(saved && efforts.includes(saved) ? saved : "");
  }, [state.activeId, selected, models]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false),
    [managing, setManaging] = useState(false);
  const [rename, setRename] = useState<string | null>(null);
  const [keepTurns, setKeepTurns] = useState(6),
    [note, setNote] = useState("");
  const contextBox = useRef<HTMLDetailsElement>(null);
  const busy = state.busy || sending || managing;
  const active = state.chats.find((c) => c.id === state.activeId);
  const receive = (value: HertaChatSnapshot) =>
    setState((old) => (value.revision >= old.revision ? value : old));
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!bridge.getHertaChat) throw new Error();
        const value = await bridge.getHertaChat();
        if (alive) receive(value);
      } catch {
        if (alive) setError("聊天记录暂不可用，请重新打开入口。");
      }
      if (alive) timer = setTimeout(poll, 400);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [bridge]);
  useEffect(() => {
    if (!visible || settingsOpen) return;
    let alive = true;
    void bridge
      .getProviderSettings()
      .then((view) => {
        if (!alive) return;
        const options = view.settings.providers.flatMap((p) =>
          p.models
            .filter(
              (m) =>
                ["text-available", "tools-available"].includes(
                  m.validation.state,
                ) &&
                m.validation.providerRevision === p.revision &&
                m.validation.protocol === p.protocol,
            )
            .map((m) => ({
              key: JSON.stringify([p.id, m.id]),
              providerId: p.id,
              modelId: m.id,
              label: `${p.name} · ${m.id}`,
              efforts: reasoningChoices(p, m.id),
            })),
        );
        setModels(options);
        const preferred = view.settings.defaultBindings?.persona;
        setDefaultModel(
          options.find(
            (m) =>
              m.providerId === preferred?.providerId &&
              m.modelId === preferred?.modelId,
          )?.key ??
            options[0]?.key ??
            "",
        );
      })
      .catch(() => {
        if (alive) setError("无法读取模型配置。");
      });
    return () => {
      alive = false;
    };
  }, [bridge, visible, settingsOpen]);
  useEffect(() => {
    activeRef.current = state.activeId;
    setRename(null);
    setNote(state.contextNote);
    setKeepTurns(6);
    follow.current = true;
    if (contextBox.current) contextBox.current.open = false;
    if (!state.activeId) {
      setDraft("");
      return;
    }
    const savedBudget = Number(
      localStorage.getItem(`the-herta.chat-budget.${state.activeId}`),
    );
    setBudget(
      (chatOutputBudgets as readonly number[]).includes(savedBudget)
        ? savedBudget
        : defaultChatOutputBudget,
    );
    const key = draftKey(state.activeId);
    // Migrate the v1 global draft exactly once, only when the target has no draft.
    const legacy = localStorage.getItem("the-herta.chat-draft.v1");
    if (legacy !== null) {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, legacy);
      localStorage.removeItem("the-herta.chat-draft.v1");
    }
    setDraft(localStorage.getItem(key) ?? "");
  }, [state.activeId]);
  useEffect(() => {
    const saved = state.activeId
      ? localStorage.getItem(modelKey(state.activeId))
      : null;
    const legacy = localStorage.getItem("the-herta.chat-model.v1");
    setSelected(
      models.find((m) => m.key === (saved ?? legacy))?.key ?? defaultModel,
    );
  }, [state.activeId, models, defaultModel]);
  useEffect(() => {
    if (visible && follow.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [state.messages, visible]);
  const changeDraft = (value: string) => {
    setDraft(value);
    if (state.activeId) localStorage.setItem(draftKey(state.activeId), value);
  };
  const manage = async (action: HertaChatAction) => {
    if (busy || !bridge.manageHertaChat) return false;
    setManaging(true);
    setError(null);
    try {
      receive(await bridge.manageHertaChat(action));
      return true;
    } catch (e) {
      setError(safeError(e));
      return false;
    } finally {
      setManaging(false);
    }
  };
  const send = async () => {
    const model = models.find((m) => m.key === selected),
      chatId = state.activeId;
    if (!draft.trim() || !model || busy || !bridge.sendHertaChat || !chatId)
      return;
    const submitted = draft;
    setSending(true);
    setError(null);
    try {
      const result = await bridge.sendHertaChat({
        chatId,
        text: submitted,
        ...(attachments.length ? { attachments } : {}),
        providerId: model.providerId,
        modelId: model.modelId,
        maxOutputTokens: budget,
        ...(effort && efforts.includes(effort)
          ? { reasoningEffort: effort }
          : {}),
      });
      if (result.accepted) {
        if (activeRef.current === chatId) setAttachments([]);
        if (localStorage.getItem(draftKey(chatId)) === submitted)
          localStorage.setItem(draftKey(chatId), "");
        if (activeRef.current === chatId)
          setDraft((value) => (value === submitted ? "" : value));
        follow.current = true;
        if (bridge.getHertaChat) receive(await bridge.getHertaChat());
      }
    } catch (e) {
      setError(safeError(e));
    } finally {
      setSending(false);
    }
  };
  const list = state.chats
    .filter((c) => !c.archived)
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  const recycled = state.chats.filter((c) => c.archived);
  const lastFailure = state.messages.at(-1)?.failure;
  const footerError =
    error ||
    (lastFailure && state.error === chatFailures[lastFailure]
      ? null
      : state.error);
  const previewStart = chatContextStart(state.messages, keepTurns);
  const previewCharacters = state.messages
    .slice(previewStart)
    .reduce((n, m) => n + m.text.length, note.trim().length);
  return (
    <section
      className="herta-chat-panel"
      role="tabpanel"
      id="herta-chat-panel"
      aria-labelledby="herta-chat-tab"
      hidden={!visible}
      onPointerDownCapture={noteActivity}
      onKeyDownCapture={noteActivity}
    >
      <header>
        <div>
          <strong>黑塔的会客室</strong>
          <small>聊天 · 记忆与文件</small>
        </div>
        <div className="herta-chat-header-actions">
          <ChatMemory memory={state.memory} onManage={manage} />
          <button type="button" onClick={onSettings}>
            连接与模型
          </button>
        </div>
      </header>
      <div className="herta-chat-body">
        <aside className="herta-chat-history" aria-label="聊天历史">
          <button
            type="button"
            disabled={busy}
            onClick={() => void manage({ type: "create" })}
          >
            ＋ 新聊天
          </button>
          <nav aria-label="保存的聊天">
            {list.map((chat) => (
              <button
                key={chat.id}
                className={chat.id === state.activeId ? "is-active" : ""}
                aria-current={chat.id === state.activeId ? "true" : undefined}
                title={chat.title}
                disabled={busy}
                onClick={() => void manage({ type: "select", id: chat.id })}
              >
                <span>
                  {chat.pinned ? "✦ " : ""}
                  {chat.title}
                </span>
              </button>
            ))}
          </nav>
          {active && (
            <div className="herta-chat-management">
              {rename !== null ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void manage({
                      type: "rename",
                      id: active.id,
                      title: rename,
                    }).then((ok) => {
                      if (ok) setRename(null);
                    });
                  }}
                >
                  <input
                    aria-label="聊天名称"
                    maxLength={80}
                    value={rename}
                    onChange={(e) => setRename(e.target.value)}
                    autoFocus
                  />
                  <button type="submit" disabled={busy || !rename.trim()}>
                    保存
                  </button>
                  <button type="button" onClick={() => setRename(null)}>
                    取消
                  </button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void manage({
                        type: "pin",
                        id: active.id,
                        pinned: !active.pinned,
                      })
                    }
                  >
                    {active.pinned ? "取消置顶" : "置顶"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setRename(active.title)}
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void manage({ type: "archive", id: active.id })
                    }
                  >
                    移到回收区
                  </button>
                </>
              )}
            </div>
          )}
          {recycled.length > 0 && (
            <details className="herta-chat-recycle">
              <summary>回收区 · {recycled.length}</summary>
              {recycled.map((chat) => (
                <div key={chat.id}>
                  <span title={chat.title}>{chat.title}</span>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`恢复聊天 ${chat.title}`}
                    onClick={() =>
                      void manage({ type: "restore", id: chat.id })
                    }
                  >
                    恢复
                  </button>
                </div>
              ))}
            </details>
          )}
        </aside>
        <section className="herta-chat-conversation" aria-label="当前聊天">
          <div className="herta-chat-thread-title">
            {active?.title ?? "选择聊天或新建聊天"}
            {state.busy && (
              <small>
                <WaitingStatus
                  startedAt={state.messages.at(-1)?.at}
                  receiving={Boolean(state.messages.at(-1)?.text)}
                />
              </small>
            )}
          </div>
          <div
            className="herta-chat-messages"
            ref={scroller}
            onScroll={() => {
              const el = scroller.current;
              if (el)
                follow.current =
                  el.scrollHeight - el.clientHeight - el.scrollTop < 60;
            }}
          >
            {state.messages.length === 0 && (
              <div className="herta-chat-empty">
                <span aria-hidden="true">✦</span>
                <h1>这次，有什么有趣的事？</h1>
                <p>可以聊研究，也可以只是来坐一会儿。</p>
              </div>
            )}
            {state.messages.map((m, i) => (
              <div key={m.id}>
                {state.contextStart > 0 && i === state.contextStart && (
                  <p className="herta-chat-context-boundary">
                    后续回复从这里开始参考；更早原文仅保留在历史中
                  </p>
                )}
                <article className={`herta-chat-message is-${m.role}`}>
                  <strong>{m.role === "assistant" ? "黑塔" : "你"}</strong>
                  <MessageTime at={m.at} />
                  {m.attachments?.map((attachment, n) => (
                    <details key={n} className="herta-chat-attachment">
                      <summary>附件 · {attachment.name}</summary>
                      <pre>{attachment.text}</pre>
                    </details>
                  ))}
                  {m.reasoning && (
                    <details className="herta-chat-reasoning">
                      <summary>
                        {m.status === "streaming" && !m.text
                          ? "正在思考…"
                          : "查看思考"}
                      </summary>
                      <pre>{m.reasoning}</pre>
                      {m.reasoningTruncated && (
                        <small>思考记录较长，仅展示前 32000 字符。</small>
                      )}
                    </details>
                  )}
                  {m.text && (
                    <MessageContent
                      text={m.text}
                      streaming={m.status === "streaming"}
                      onMemory={
                        m.role === "assistant" && m.status === "complete"
                          ? manage
                          : undefined
                      }
                      memoryItems={state.memory?.items}
                      downloadable={
                        m.role === "assistant" && m.status === "complete"
                      }
                    />
                  )}
                  {m.failure && (
                    <p className="herta-chat-failure">
                      {chatFailures[m.failure]}
                    </p>
                  )}
                  {m.status !== "complete" && (
                    <small>
                      {m.status === "streaming"
                        ? "正在回复…"
                        : m.status === "cancelled"
                          ? "已停止"
                          : m.status === "interrupted"
                            ? "上次回复已中断"
                            : "回复未完成"}
                    </small>
                  )}
                </article>
              </div>
            ))}
          </div>
          <footer>
            {footerError && <p role="alert">{footerError}</p>}
            {!models.length && (
              <p>
                先在连接设置中验证一个对话模型。
                <button
                  type="button"
                  onClick={() => {
                    onSettings();
                  }}
                >
                  打开设置
                </button>
              </p>
            )}
            {active && (
              <details
                className="herta-chat-context"
                ref={contextBox}
                onToggle={(e) => {
                  if (e.currentTarget.open) setNote(state.contextNote);
                }}
              >
                <summary>
                  续聊范围
                  {state.contextStart > 0 || state.contextNote
                    ? " · 已调整"
                    : ""}
                  {state.contextCharacters >= 128000 ? " · 建议精简" : ""}
                </summary>
                <div>
                  <p>
                    更早的消息仍可阅读，但不再发送给模型。可补充需要记住的要点；不会自动生成摘要。
                  </p>
                  <label>
                    保留范围
                    <select
                      aria-label="保留范围"
                      value={keepTurns}
                      disabled={busy}
                      onChange={(e) => setKeepTurns(Number(e.target.value))}
                    >
                      <option value={-1}>全部历史</option>
                      <option value={12}>最近12轮</option>
                      <option value={6}>最近6轮</option>
                      <option value={3}>最近3轮</option>
                      <option value={0}>仅从下一条消息开始</option>
                    </select>
                  </label>
                  <textarea
                    aria-label="续聊要点"
                    placeholder="可选：人物称呼、偏好、前情或尚未解决的问题…"
                    maxLength={4000}
                    value={note}
                    disabled={busy}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <small>
                    将保留 {state.messages.length - previewStart} 条消息，约{" "}
                    {previewCharacters.toLocaleString()} 字符（不是 tokens）。
                  </small>
                  <button
                    type="button"
                    disabled={busy || previewCharacters > 128000}
                    onClick={() =>
                      void manage({
                        type: "context",
                        id: active.id,
                        keepTurns,
                        note,
                      }).then((ok) => {
                        if (ok && contextBox.current)
                          contextBox.current.open = false;
                      })
                    }
                  >
                    应用续聊范围
                  </button>
                  {previewCharacters > 128000 && (
                    <p>内容仍较长，请减少保留轮次。</p>
                  )}
                </div>
              </details>
            )}
            {attachments.length > 0 && (
              <ul className="herta-chat-pending-files">
                {attachments.map((a, i) => (
                  <li key={i}>
                    {a.name}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        setAttachments((v) => v.filter((_, n) => n !== i))
                      }
                    >
                      移除附件
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <textarea
              aria-label="给黑塔的消息"
              placeholder={active ? "说点什么…" : "先新建或恢复一个聊天"}
              disabled={!active || managing}
              value={draft}
              maxLength={32000}
              onChange={(e) => changeDraft(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  (e.ctrlKey || e.metaKey) &&
                  !e.nativeEvent.isComposing &&
                  e.nativeEvent.keyCode !== 229
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="herta-chat-controls">
              <label className="herta-chat-upload">
                ＋ 附加文本文件
                <input
                  type="file"
                  multiple
                  disabled={busy || !active}
                  accept=".txt,.md,.csv,.json,.xml,.yaml,.yml,.html,.css,.js,.ts,.tsx,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.sql,.log"
                  onChange={async (e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    const chatId = state.activeId;
                    try {
                      if (files.some((f) => f.size > 128000)) throw new Error();
                      const uploaded = await Promise.all(
                        files.map(async (f) => ({
                          name: f.name,
                          text: new TextDecoder("utf-8", {
                            fatal: true,
                          }).decode(await f.arrayBuffer()),
                        })),
                      );
                      const next = validateChatAttachments([
                        ...attachments,
                        ...uploaded,
                      ]);
                      if (activeRef.current === chatId) setAttachments(next);
                    } catch {
                      setError(
                        "请选择 UTF-8 文本或代码文件，最多4个，每个32000字、合计64000字。",
                      );
                    }
                  }}
                />
              </label>
              <select
                aria-label="聊天模型"
                value={selected}
                disabled={busy || !active}
                onChange={(e) => {
                  setSelected(e.target.value);
                  if (state.activeId)
                    localStorage.setItem(
                      modelKey(state.activeId),
                      e.target.value,
                    );
                }}
              >
                <option value="" disabled>
                  选择模型
                </option>
                {models.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
              {efforts.length > 0 && (
                <label className="herta-chat-budget">
                  思考
                  <select
                    aria-label="聊天思考强度"
                    disabled={busy || !active}
                    value={effort}
                    onChange={(e) => {
                      setEffort(e.target.value);
                      if (state.activeId)
                        localStorage.setItem(
                          `the-herta.chat-effort.${state.activeId}.${selected}`,
                          e.target.value,
                        );
                    }}
                  >
                    <option value="">服务默认</option>
                    {efforts.map((value) => (
                      <option key={value} value={value}>
                        {effortLabels[value] ?? value}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="herta-chat-budget">
                回复额度
                <select
                  aria-label="回复额度"
                  value={budget}
                  disabled={busy || !active}
                  title="单次请求的输出 tokens 上限，可能包含模型思考；上限不等于实际消耗。"
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    setBudget(value);
                    if (state.activeId)
                      localStorage.setItem(
                        `the-herta.chat-budget.${state.activeId}`,
                        String(value),
                      );
                  }}
                >
                  {chatOutputBudgets.map((value) => (
                    <option key={value} value={value}>
                      {value / 1024}k
                    </option>
                  ))}
                </select>
              </label>
              <span>Ctrl+Enter 发送</span>
              {state.busy ? (
                <button
                  type="button"
                  onClick={() =>
                    void bridge
                      .stopHertaChat?.()
                      .catch(() => setError("停止请求未完成，请稍后再试。"))
                  }
                >
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy || !draft.trim() || !selected || !active}
                  onClick={() => void send()}
                >
                  发送 ↑
                </button>
              )}
            </div>
          </footer>
        </section>
      </div>
    </section>
  );
}
