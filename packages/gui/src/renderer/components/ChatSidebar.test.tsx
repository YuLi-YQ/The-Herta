import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { gsap } from "gsap";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSidebar, relativeTime } from "./ChatSidebar.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const chat = (id: string, title: string, minutesAgo: number, extra = {}) => ({
  id,
  title,
  updatedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
  pinned: false,
  archived: false,
  messageCount: 1,
  ...extra,
});

describe("relativeTime", () => {
  it("speaks in the sidebar's short form", () => {
    const at = (minutes: number) =>
      relativeTime(new Date(NOW - minutes * 60_000).toISOString(), NOW);
    expect(at(0)).toBe("刚刚");
    expect(at(5)).toBe("5分钟");
    expect(at(180)).toBe("3小时");
    expect(at(2 * 24 * 60)).toBe("2天");
    expect(relativeTime("2026-03-04T08:00:00", NOW)).toBe("3月4日");
    expect(relativeTime("now", NOW)).toBe("");
  });
});

describe("ChatSidebar", () => {
  it("groups pinned chats, names rows by title and acts on the row whose menu was opened", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const manage = vi.fn(async () => true);
    render(
      <ChatSidebar
        chats={[
          chat("a", "当前话题", 3),
          chat("b", "旧话题", 60 * 26),
          chat("p", "置顶话题", 10, { pinned: true }),
          chat("r", "回收的话题", 5, { archived: true }),
        ]}
        activeId="a"
        busy={false}
        manage={manage}
      />,
    );
    vi.useRealTimers();
    expect(screen.getByRole("heading", { name: "置顶" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "最近" })).toBeInTheDocument();
    const old = screen.getByRole("button", { name: "旧话题" });
    expect(old).toHaveAccessibleDescription("1天");
    expect(screen.getByRole("button", { name: "当前话题" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "聊天操作 旧话题" }));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "置顶" })).toHaveFocus(),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "移到回收区" }));
    expect(manage).toHaveBeenCalledWith({ type: "archive", id: "b" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "聊天操作 置顶话题" }));
    expect(screen.getByRole("menuitem", { name: "取消置顶" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape", isComposing: true });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "聊天操作 置顶话题" })).toHaveFocus();
    expect(screen.getByText("回收区 · 1")).toBeInTheDocument();
  });

  it("moves through a row's menu with the arrow keys and closes it on Tab", () => {
    render(
      <ChatSidebar
        chats={[chat("a", "当前话题", 3)]}
        activeId="a"
        busy={false}
        manage={vi.fn(async () => true)}
      />,
    );
    const more = screen.getByRole("button", { name: "聊天操作 当前话题" });
    fireEvent.click(more);
    expect(screen.getByRole("menuitem", { name: "置顶" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "重命名" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "移到回收区" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as Element, { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(more).toHaveFocus();
  });

  it("renames a row in place and keeps the field until the save succeeds", async () => {
    const manage = vi.fn(async () => false);
    render(
      <ChatSidebar
        chats={[chat("a", "当前话题", 3), chat("b", "旧话题", 30)]}
        activeId="a"
        busy={false}
        manage={manage}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "聊天操作 旧话题" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const field = screen.getByRole("textbox", { name: "聊天名称" });
    expect(field).toHaveValue("旧话题");
    fireEvent.change(field, { target: { value: "新名字" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(manage).toHaveBeenCalledWith({
        type: "rename",
        id: "b",
        title: "新名字",
      }),
    );
    expect(screen.getByRole("textbox", { name: "聊天名称" })).toHaveValue("新名字");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "聊天名称" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("textbox", { name: "聊天名称" })).toBeNull();
    expect(screen.getByRole("button", { name: "旧话题" })).toBeInTheDocument();
  });
});

describe("ChatSidebar motion (R54)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.appearance;
    delete document.documentElement.dataset.motion;
  });

  it("slides in a chat created while the list is open, never the list on load or a pinned move", () => {
    document.documentElement.dataset.appearance = "observatory";
    document.documentElement.dataset.motion = "system";
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("no-preference"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const from = vi.spyOn(gsap, "from");
    const manage = vi.fn(async () => true);
    const view = render(
      <ChatSidebar
        chats={[chat("a", "当前话题", 3), chat("b", "旧话题", 60)]}
        activeId="a"
        busy={false}
        manage={manage}
      />,
    );
    expect(from).not.toHaveBeenCalled();
    view.rerender(
      <ChatSidebar
        chats={[
          chat("n", "新聊天", 0),
          chat("a", "当前话题", 3),
          chat("b", "旧话题", 60),
        ]}
        activeId="n"
        busy={false}
        manage={manage}
      />,
    );
    expect(from).toHaveBeenCalledTimes(1);
    const [targets, vars] = from.mock.calls[0] as [
      HTMLElement[],
      gsap.TweenVars,
    ];
    expect(targets.map((el) => el.getAttribute("data-entrance"))).toEqual([
      "n",
    ]);
    expect(vars).toMatchObject({ opacity: 0, x: -6 });
    view.rerender(
      <ChatSidebar
        chats={[
          chat("n", "新聊天", 0),
          chat("a", "当前话题", 3, { pinned: true }),
          chat("b", "旧话题", 60),
        ]}
        activeId="n"
        busy={false}
        manage={manage}
      />,
    );
    expect(from).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
