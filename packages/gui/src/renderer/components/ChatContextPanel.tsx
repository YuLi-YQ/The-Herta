import { useEffect, useRef, useState } from "react";
import {
  chatContextStart,
  type HertaChatSnapshot,
} from "../../shared/herta-chat.js";
import { useHertaBridge } from "../context/HertaBridgeContext.js";
import { closeDetailsOnEscape } from "../lib/details-popover.js";
import { playEntrance } from "../lib/gsap-motion.js";
import { formatStamp } from "./Sidebar/session-markdown.js";

export interface ContextModel {
  providerId: string;
  modelId: string;
  providerRevision: number;
  reasoningEffort?: string;
}
interface ContextDraft {
  note: string;
  keepTurns: number;
  revision: number;
  edit: number;
  dirty: boolean;
  generated?: { boundary: number; at: string };
}

/** Notes are composer drafts until the user applies them; model output never saves itself. */
export function useChatContext(
  state: HertaChatSnapshot,
  model: ContextModel | null,
  busy: boolean,
  shown: boolean,
  receive: (state: HertaChatSnapshot) => void,
  onSaving: (saving: boolean) => void,
) {
  const { bridge } = useHertaBridge();
  const box = useRef<HTMLDetailsElement>(null);
  const drafts = useRef(new Map<string, ContextDraft>());
  const epoch = useRef({ key: state.activeId, value: 0 });
  if (epoch.current.key !== state.activeId)
    epoch.current = { key: state.activeId, value: epoch.current.value + 1 };
  const current = useRef({ state, model, busy, shown });
  current.current = { state, model, busy, shown };
  const modelKey = JSON.stringify(model);
  const generation = useRef<{ id: string; chatId: string } | null>(null);
  const saving = useRef(false);
  const mounted = useRef(true);
  const [, redraw] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = state.activeId;
  const draft = key
    ? (drafts.current.get(key) ?? {
        note: state.contextNote,
        keepTurns: -2,
        revision: state.revision,
        edit: 0,
        dirty: false,
      })
    : {
        note: "",
        keepTurns: -2,
        revision: state.revision,
        edit: 0,
        dirty: false,
      };
  if (key && !drafts.current.has(key)) drafts.current.set(key, draft);
  const cancel = (announce = true) => {
    const job = generation.current;
    if (!job) return;
    generation.current = null;
    void bridge
      .cancelChatContextDraft?.({ chatId: job.chatId, requestId: job.id })
      .catch(() => undefined);
    if (mounted.current) {
      redraw((n) => n + 1);
      if (announce) setNotice("起草已取消，原要点保持不变。");
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel(false);
    };
  }, []);
  useEffect(() => {
    cancel(false);
    setNotice(null);
    setError(null);
    if (!shown || epoch.current.key === key) {
      if (box.current) box.current.open = false;
    }
  }, [key, shown]);
  useEffect(() => {
    cancel(false);
  }, [modelKey, busy, state.revision]);
  useEffect(() => {
    const saved = key ? drafts.current.get(key) : undefined;
    if (key && saved && !saved.dirty && saved.revision !== state.revision) {
      drafts.current.set(key, {
        ...saved,
        note: state.contextNote,
        revision: state.revision,
      });
      redraw((n) => n + 1);
    }
  }, [key, state.revision, state.contextNote]);
  const edit = (change: Partial<Pick<ContextDraft, "note" | "keepTurns">>) => {
    if (!key || saving.current || busy) return;
    cancel(false);
    setNotice(null);
    setError(null);
    drafts.current.set(key, {
      ...draft,
      ...change,
      generated: undefined,
      edit: draft.edit + 1,
      dirty: true,
    });
    redraw((n) => n + 1);
  };
  const open = () => {
    if (!key || !box.current) return;
    if (!draft.dirty)
      drafts.current.set(key, {
        ...draft,
        note: state.contextNote,
        revision: state.revision,
      });
    setNotice(null);
    setError(null);
    redraw((n) => n + 1);
    box.current.open = true;
    const capture = epoch.current.value;
    requestAnimationFrame(() => {
      if (
        current.current.shown &&
        epoch.current.value === capture &&
        box.current?.open
      )
        box.current
          .querySelector<HTMLElement>("select")
          ?.focus({ preventScroll: true });
    });
  };
  const begin = async () => {
    if (
      !key ||
      !model ||
      busy ||
      saving.current ||
      generation.current ||
      !bridge.draftChatContext ||
      !bridge.cancelChatContextDraft
    )
      return;
    const capture = epoch.current.value,
      editVersion = draft.edit;
    const revision = state.revision;
    const job = { chatId: key, id: crypto.randomUUID() };
    generation.current = job;
    setError(null);
    setNotice(null);
    redraw((n) => n + 1);
    const valid = () =>
      mounted.current &&
      generation.current === job &&
      epoch.current.value === capture &&
      current.current.state.activeId === key &&
      current.current.state.revision === revision &&
      JSON.stringify(current.current.model) === modelKey &&
      !current.current.busy &&
      current.current.shown &&
      drafts.current.get(key)?.edit === editVersion;
    try {
      const result = await bridge.draftChatContext({
        chatId: key,
        requestId: job.id,
        expectedRevision: revision,
        keepTurns: draft.keepTurns,
        ...model,
      });
      if (!valid()) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (
        result.chatId !== key ||
        result.requestId !== job.id ||
        result.revision !== revision ||
        result.keepTurns !== draft.keepTurns ||
        result.providerId !== model.providerId ||
        result.modelId !== model.modelId ||
        result.providerRevision !== model.providerRevision ||
        !result.text.trim() ||
        result.text.length > 4000
      ) {
        setError("返回的要点与当前聊天不一致，原要点保持不变。");
        return;
      }
      drafts.current.set(key, {
        ...draft,
        note: result.text,
        revision,
        edit: draft.edit + 1,
        dirty: true,
        generated: { boundary: result.boundaryIndex, at: result.generatedAt },
      });
      setNotice("要点已起草，请检查、修改后再应用续聊范围。");
    } catch {
      if (valid()) setError("要点未能生成，原要点保持不变，请稍后重试。");
    } finally {
      if (generation.current === job) {
        generation.current = null;
        if (mounted.current) redraw((n) => n + 1);
      }
    }
  };
  const apply = async () => {
    if (
      !key ||
      busy ||
      saving.current ||
      generation.current ||
      !bridge.manageHertaChat ||
      draft.revision !== state.revision ||
      draft.note.length > 4000
    )
      return;
    const capture = epoch.current.value,
      editVersion = draft.edit;
    saving.current = true;
    onSaving(true);
    setError(null);
    try {
      const result = await bridge.manageHertaChat({
        type: "context",
        id: key,
        keepTurns: draft.keepTurns,
        note: draft.note,
        expectedRevision: draft.revision,
      });
      if (
        !mounted.current ||
        epoch.current.value !== capture ||
        current.current.state.activeId !== key ||
        drafts.current.get(key)?.edit !== editVersion
      )
        return;
      receive(result);
      drafts.current.set(key, {
        ...draft,
        revision: result.revision,
        dirty: false,
      });
      if (box.current) box.current.open = false;
    } catch {
      if (mounted.current && epoch.current.value === capture)
        setError("续聊范围未保存，草稿仍保留。请复查当前记录后重试。");
    } finally {
      saving.current = false;
      if (mounted.current) {
        onSaving(false);
        redraw((n) => n + 1);
      }
    }
  };
  const refresh = () => {
    if (!key) return;
    drafts.current.set(key, { ...draft, revision: state.revision });
    setError(null);
    redraw((n) => n + 1);
  };
  const boundary =
    draft.keepTurns === -2
      ? state.contextStart
      : chatContextStart(state.messages, draft.keepTurns);
  const characters = state.messages
    .slice(boundary)
    .reduce((n, message) => n + message.text.length, draft.note.trim().length);
  return {
    box,
    open,
    edit,
    draft,
    begin,
    cancel,
    apply,
    refresh,
    boundary,
    characters,
    notice,
    error,
    busy,
    saving: saving.current,
    generating: generation.current !== null,
    stale: draft.revision !== state.revision,
    available: Boolean(
      bridge.draftChatContext && bridge.cancelChatContextDraft,
    ),
    canGenerate: Boolean(model) && boundary > 0,
    state,
  };
}

export function ChatContextPanel({
  context,
}: {
  readonly context: ReturnType<typeof useChatContext>;
}) {
  const entrance = useRef<ReturnType<typeof playEntrance>>(null);
  useEffect(
    () => () => {
      entrance.current?.revert();
    },
    [],
  );
  return (
    <details
      className="herta-chat-context"
      ref={context.box}
      onKeyDown={(event) => {
        closeDetailsOnEscape(event);
        if (!event.currentTarget.open) context.cancel(false);
      }}
      onToggle={(event) => {
        entrance.current?.revert();
        entrance.current = null;
        if (!event.currentTarget.open) {
          context.cancel(false);
          return;
        }
        const popover =
          event.currentTarget.querySelector<HTMLElement>(":scope > div");
        if (popover) entrance.current = playEntrance(popover, "popover-up");
      }}
    >
      <summary
        onClick={(event) => {
          event.preventDefault();
          if (context.box.current?.open) {
            context.box.current.open = false;
            context.cancel(false);
          } else context.open();
        }}
      >
        续聊范围
        {context.state.contextStart > 0 || context.state.contextNote
          ? " · 已调整"
          : ""}
        {context.state.contextCharacters >= 128000 ? " · 建议精简" : ""}
      </summary>
      <div>
        <p>
          更早的消息仍可阅读，但不再发送给模型。可请黑塔起草要点，检查、修改并应用后才用于续聊。
        </p>
        <label>
          保留范围
          <select
            aria-label="保留范围"
            value={context.draft.keepTurns}
            disabled={context.busy || context.saving}
            onChange={(e) =>
              context.edit({ keepTurns: Number(e.target.value) })
            }
          >
            <option value={-2}>
              当前已保存范围（
              {context.state.messages.length - context.state.contextStart}{" "}
              条消息）
            </option>
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
          value={context.draft.note}
          disabled={context.busy || context.saving}
          onChange={(e) => context.edit({ note: e.target.value })}
        />
        <small>
          将保留 {context.state.messages.length - context.boundary} 条消息，约{" "}
          {context.characters.toLocaleString()} 字符（不是 tokens）。
        </small>
        {context.draft.generated && (
          <small>
            要点取自更早的 {context.draft.generated.boundary} 条消息 ·{" "}
            {formatStamp(context.draft.generated.at)}
          </small>
        )}
        {context.available && (
          <div className="herta-actions">
            {context.generating ? (
              <button type="button" onClick={() => context.cancel()}>
                取消起草
              </button>
            ) : (
              <button
                type="button"
                disabled={
                  context.busy || context.saving || !context.canGenerate
                }
                onClick={() => void context.begin()}
              >
                起草要点
              </button>
            )}
          </div>
        )}
        {context.generating && <p role="status">黑塔正在整理更早的消息…</p>}
        {context.notice && <p role="status">{context.notice}</p>}
        {context.error && <p role="alert">{context.error}</p>}
        {context.stale && (
          <p>
            聊天记录已更新，草稿仍保留。
            <button
              type="button"
              disabled={context.busy || context.saving || context.generating}
              onClick={context.refresh}
            >
              保留草稿并采用当前记录
            </button>
          </p>
        )}
        <button
          type="button"
          disabled={
            context.busy ||
            context.saving ||
            context.generating ||
            context.stale ||
            context.characters > 128000 ||
            context.draft.note.length > 4000
          }
          onClick={() => void context.apply()}
        >
          应用续聊范围
        </button>
        {context.characters > 128000 && <p>内容仍较长，请减少保留轮次。</p>}
      </div>
    </details>
  );
}
