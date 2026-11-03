import { useEffect, useRef, useState } from "react";
import type { HertaChatAction, HertaChatSnapshot } from "../../shared/herta-chat.js";
import { useAppendEntrance, useEntrance } from "../lib/gsap-motion.js";
import { Icon } from "./Icon.js";

type Chat = HertaChatSnapshot["chats"][number];

/** How long ago, in the sidebar's short form: 刚刚, 5分钟, 3小时, 2天, then the date. */
export function relativeTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天`;
  const date = new Date(at);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * The chat list, laid out like the workbench's task list (R46): 置顶 and 最近
 * groups, a relative time on each row, and each row's actions behind its own
 * ··· menu instead of a button strip under the list. The menu renders only
 * while open, so one row's actions never shadow another's.
 */
export function ChatSidebar({
  chats,
  activeId,
  busy,
  manage,
  visible = true,
}: {
  chats: readonly Chat[];
  activeId: string | null;
  busy: boolean;
  manage: (action: HertaChatAction) => Promise<boolean>;
  visible?: boolean;
}) {
  const [menu, setMenu] = useState<string | null>(null);
  useEffect(() => { if (!visible) setMenu(null); }, [visible]);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const live = chats
    .filter((c) => !c.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const groups = [
    { label: "置顶", items: live.filter((c) => c.pinned) },
    { label: "最近", items: live.filter((c) => !c.pinned) },
  ].filter((group) => group.items.length > 0);
  const recycled = chats.filter((c) => c.archived);
  // A chat created (or restored) while the list is open slides in; the list
  // shown on load never does, and pinning moves a row without replaying (R54).
  const list = useRef<HTMLElement>(null);
  useAppendEntrance(
    list,
    live.map((c) => c.id),
    "chats",
    "row",
    visible,
  );
  const act = (action: HertaChatAction) => {
    setMenu(null);
    void manage(action);
  };
  return (
    <aside className="herta-chat-history" aria-label="聊天历史">
      <button
        type="button"
        className="herta-chat-new"
        disabled={busy}
        onClick={() => void manage({ type: "create" })}
      >
        <Icon name="plus" />
        <span className="herta-icon-label">新建聊天</span>
      </button>
      <nav aria-label="保存的聊天" ref={list}>
        {groups.map((group) => (
          <section key={group.label} className="herta-chat-group">
            <h2>{group.label}</h2>
            <ul>
              {group.items.map((chat) => (
                <ChatRow
                  key={chat.id}
                  chat={chat}
                  visible={visible}
                  active={chat.id === activeId}
                  busy={busy}
                  now={now}
                  menuOpen={menu === chat.id}
                  renaming={renaming?.id === chat.id ? renaming.title : null}
                  onSelect={() => void manage({ type: "select", id: chat.id })}
                  onMenu={(open) => setMenu(open ? chat.id : null)}
                  onPin={() =>
                    act({ type: "pin", id: chat.id, pinned: !chat.pinned })
                  }
                  onRenameStart={() => {
                    setMenu(null);
                    setRenaming({ id: chat.id, title: chat.title });
                  }}
                  onRenameChange={(title) => setRenaming({ id: chat.id, title })}
                  onRenameCancel={() => setRenaming(null)}
                  onRenameSave={(title) =>
                    void manage({ type: "rename", id: chat.id, title }).then(
                      (ok) => {
                        if (ok) setRenaming(null);
                      },
                    )
                  }
                  onArchive={() => act({ type: "archive", id: chat.id })}
                />
              ))}
            </ul>
          </section>
        ))}
      </nav>
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
                onClick={() => void manage({ type: "restore", id: chat.id })}
              >
                恢复
              </button>
            </div>
          ))}
        </details>
      )}
    </aside>
  );
}

function ChatRow({
  chat,
  visible,
  active,
  busy,
  now,
  menuOpen,
  renaming,
  onSelect,
  onMenu,
  onPin,
  onRenameStart,
  onRenameChange,
  onRenameCancel,
  onRenameSave,
  onArchive,
}: {
  chat: Chat;
  visible: boolean;
  active: boolean;
  busy: boolean;
  now: number;
  menuOpen: boolean;
  renaming: string | null;
  onSelect: () => void;
  onMenu: (open: boolean) => void;
  onPin: () => void;
  onRenameStart: () => void;
  onRenameChange: (title: string) => void;
  onRenameCancel: () => void;
  onRenameSave: (title: string) => void;
  onArchive: () => void;
}) {
  const row = useRef<HTMLLIElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // The chat re-renders on every 400ms poll; listeners read the latest
  // callback through this ref so an open menu is not re-armed (or refocused).
  const toggle = useRef(onMenu);
  toggle.current = onMenu;
  const field = useRef<HTMLInputElement>(null);
  const isRenaming = renaming !== null;
  useEffect(() => {
    if (isRenaming) field.current?.focus({ preventScroll: true });
  }, [isRenaming]);
  useEntrance(menu, "popover-down", menuOpen, visible);
  useEffect(() => {
    if (!menuOpen || !visible) return;
    menu.current
      ?.querySelector<HTMLButtonElement>("button")
      ?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => {
      if (!row.current?.contains(e.target as Node)) toggle.current(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.keyCode === 229) return;
      e.stopPropagation();
      toggle.current(false);
      more.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [menuOpen, visible]);
  const timeId = `herta-chat-time-${chat.id}`;
  if (renaming !== null)
    return (
      <li
        className="herta-chat-row is-renaming"
        ref={row}
        data-entrance={chat.id}
      >
        <form
          className="herta-chat-rename"
          onSubmit={(e) => {
            e.preventDefault();
            onRenameSave(renaming);
          }}
        >
          <input
            ref={field}
            aria-label="聊天名称"
            maxLength={80}
            value={renaming}
            onChange={(e) => onRenameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                onRenameCancel();
              }
            }}
          />
          <div className="herta-chat-actions">
            <button type="submit" disabled={busy || !renaming.trim()}>
              保存
            </button>
            <button type="button" onClick={onRenameCancel}>
              取消
            </button>
          </div>
        </form>
      </li>
    );
  return (
    <li
      className={`herta-chat-row${active ? " is-active" : ""}`}
      ref={row}
      data-entrance={chat.id}
    >
      <button
        type="button"
        className="herta-chat-row-main"
        aria-label={chat.title}
        aria-describedby={timeId}
        aria-current={active ? "true" : undefined}
        title={chat.title}
        disabled={busy}
        onClick={onSelect}
      >
        <span className="herta-chat-row-title">
          {chat.pinned && <Icon name="spark" className="herta-pin-mark" />}
          {chat.title}
        </span>
        <small id={timeId} className="herta-chat-row-time">
          {relativeTime(chat.updatedAt, now)}
        </small>
      </button>
      <button
        ref={more}
        type="button"
        className="herta-chat-row-more"
        aria-label={`聊天操作 ${chat.title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={busy}
        onClick={() => onMenu(!menuOpen)}
      >
        <Icon name="more" />
      </button>
      {menuOpen && (
        <div
          className="herta-chat-row-menu"
          role="menu"
          aria-label={`聊天操作 ${chat.title}`}
          ref={menu}
          // Same keys as the workbench's session menu: arrows move, Tab closes.
          onKeyDown={(e) => {
            if (e.key === "Tab") {
              e.preventDefault();
              onMenu(false);
              more.current?.focus({ preventScroll: true });
              return;
            }
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            const items = [
              ...(menu.current?.querySelectorAll<HTMLButtonElement>(
                "[role='menuitem']",
              ) ?? []),
            ];
            const at = items.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              e.key === "ArrowDown"
                ? (at + 1) % items.length
                : (at - 1 + items.length) % items.length;
            items[next]?.focus({ preventScroll: true });
          }}
        >
          <button type="button" role="menuitem" onClick={onPin}>
            {chat.pinned ? "取消置顶" : "置顶"}
          </button>
          <button type="button" role="menuitem" onClick={onRenameStart}>
            重命名
          </button>
          <button type="button" role="menuitem" onClick={onArchive}>
            移到回收区
          </button>
        </div>
      )}
    </li>
  );
}
