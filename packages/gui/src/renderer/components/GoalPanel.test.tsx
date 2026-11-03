import type { GoalReply, GoalView } from "@herta/core";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ bridge: {} as Record<string, unknown> }));
vi.mock("../context/HertaBridgeContext.js", () => ({
  useHertaBridge: () => ({ bridge: mock.bridge }),
}));

import { GoalPanel, GoalStrip, useGoalController } from "./GoalPanel.js";

const empty = (): GoalView => ({
  state: { revision: 0, active: null, history: [] },
});
const active = (text = "整理附件", revision = 1): GoalView => ({
  state: {
    revision,
    active: { text, status: "active", setAt: "2026-11-01T00:00:00Z", revision },
    history: [],
  },
});
const read = () => mock.bridge.getSessionGoal as ReturnType<typeof vi.fn>;
const write = () => mock.bridge.updateSessionGoal as ReturnType<typeof vi.fn>;
function Host({
  target = "a",
  busy = false,
  shown = true,
  scope = "workbench",
}: {
  target?: string | null;
  busy?: boolean;
  shown?: boolean;
  scope?: "workbench" | "chat";
}) {
  const goal = useGoalController(scope, target, busy, shown);
  return (
    <>
      <button type="button" onClick={goal.open}>
        打开目标面板
      </button>
      <GoalStrip goal={goal} />
      <GoalPanel goal={goal} />
    </>
  );
}
async function open() {
  const button = screen.getByRole("button", { name: "打开目标面板" });
  button.focus();
  fireEvent.click(button);
  await waitFor(() => expect(screen.queryByText("正在读取目标…")).toBeNull());
  return button;
}
const text = () => screen.getByRole("textbox", { name: "目标内容" });
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  mock.bridge = {
    getSessionGoal: vi.fn(
      async (): Promise<GoalReply> => ({ ok: true, view: empty() }),
    ),
    updateSessionGoal: vi.fn(
      async (): Promise<GoalReply> => ({ ok: true, view: active() }),
    ),
  };
});

describe("shared /goal panel (R129)", () => {
  it("describes a storage failure during read as a read problem, not a failed save", async () => {
    read().mockResolvedValue({ ok: false, reason: "storage" });
    render(<Host />);
    await open();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "暂时无法读取目标，请重试。",
    );
    expect(screen.queryByText(/目标没有保存/)).toBeNull();
    expect(write()).not.toHaveBeenCalled();
  });
  it("creates a goal with its revision and displays only an active goal above the composer", async () => {
    render(<Host />);
    await open();
    expect(screen.queryByRole("region", { name: "当前目标" })).toBeNull();
    expect(screen.getByRole("button", { name: "设置目标" })).toBeDisabled();
    fireEvent.change(text(), { target: { value: "整理附件" } });
    fireEvent.click(screen.getByRole("button", { name: "设置目标" }));
    await screen.findByText("目标已保存。");
    expect(write()).toHaveBeenCalledWith("a", 0, {
      type: "set",
      text: "整理附件",
    });
    expect(screen.getByRole("region", { name: "当前目标" })).toHaveTextContent(
      "整理附件",
    );
  });
  it("counts code points, rejects overlong text and keeps unsaved text across close/hide", async () => {
    const { rerender } = render(<Host />);
    const opener = await open();
    const value = "🌟".repeat(500);
    fireEvent.change(text(), { target: { value } });
    expect(screen.getByRole("button", { name: "设置目标" })).not.toBeDisabled();
    expect(screen.getByText("500 / 500 字")).toBeInTheDocument();
    fireEvent.change(text(), { target: { value: `${value}星` } });
    expect(screen.getByRole("button", { name: "设置目标" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "关闭目标" }));
    expect(opener).toHaveFocus();
    await open();
    expect(text()).toHaveValue(`${value}星`);
    rerender(<Host shown={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<Host />);
    await open();
    expect(text()).toHaveValue(`${value}星`);
  });
  it("keeps the draft on conflict, uses the newer revision on retry and retains write failures", async () => {
    read().mockResolvedValue({ ok: true, view: active("服务器旧目标", 3) });
    write()
      .mockResolvedValueOnce({
        ok: false,
        reason: "conflict",
        view: active("服务器新目标", 4),
      })
      .mockRejectedValueOnce(new Error("disk"));
    render(<Host />);
    await open();
    fireEvent.change(text(), { target: { value: "我的修改" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByText(/目标已更新，已读取最新记录/);
    expect(text()).toHaveValue("我的修改");
    expect(screen.getByRole("region", { name: "当前目标" })).toHaveTextContent(
      "服务器新目标",
    );
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByText(/目标没有保存/);
    expect(write()).toHaveBeenLastCalledWith("a", 4, {
      type: "set",
      text: "我的修改",
    });
    expect(text()).toHaveValue("我的修改");
  });
  it("does not finish an unsaved replacement text, and records the explicit completion result in history", async () => {
    read().mockResolvedValue({ ok: true, view: active() });
    const ended = {
      ...active().state.active!,
      status: "done" as const,
      endedAt: "2026-11-01T00:02:00Z",
      result: "已核对",
      revision: 2,
    };
    write().mockResolvedValue({
      ok: true,
      view: { state: { revision: 2, active: null, history: [ended] } },
    });
    render(<Host />);
    await open();
    fireEvent.change(text(), { target: { value: "尚未保存的新目标" } });
    expect(screen.getByRole("button", { name: "标记已完成" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "放弃目标" })).toBeDisabled();
    fireEvent.change(text(), { target: { value: "整理附件" } });
    fireEvent.change(screen.getByLabelText("结果说明（可选）"), {
      target: { value: "已核对" },
    });
    fireEvent.click(screen.getByRole("button", { name: "标记已完成" }));
    await screen.findByText("已记录为完成。");
    expect(write()).toHaveBeenCalledWith("a", 1, {
      type: "end",
      status: "done",
      result: "已核对",
    });
    expect(screen.queryByRole("region", { name: "当前目标" })).toBeNull();
    expect(screen.getByText("已结束的目标 · 1")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
  });
  it("allows reading while busy but blocks changes, duplicate saving and Esc during the write", async () => {
    read().mockResolvedValue({ ok: true, view: active() });
    let finish!: (reply: GoalReply) => void;
    write().mockImplementation(
      () =>
        new Promise<GoalReply>((r) => {
          finish = r;
        }),
    );
    const { rerender } = render(<Host busy />);
    await open();
    expect(text()).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "保存修改" })).toBeDisabled();
    rerender(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    expect(write()).toHaveBeenCalledTimes(1);
    const event = new Event("cancel", { cancelable: true });
    fireEvent(screen.getByRole("dialog"), event);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByRole("button", { name: "关闭目标" })).toBeDisabled();
    await act(async () => finish({ ok: true, view: active() }));
  });
  it("drops an old read across A → B → A", async () => {
    let finish!: (reply: GoalReply) => void;
    read()
      .mockImplementationOnce(
        () =>
          new Promise<GoalReply>((r) => {
            finish = r;
          }),
      )
      .mockResolvedValue({ ok: true, view: active("当前读取", 2) });
    const { rerender } = render(<Host />);
    rerender(<Host target="b" />);
    rerender(<Host />);
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "当前目标" }),
      ).toHaveTextContent("当前读取"),
    );
    await act(async () => finish({ ok: true, view: active("迟到读取", 1) }));
    expect(
      screen.getByRole("region", { name: "当前目标" }),
    ).not.toHaveTextContent("迟到读取");
  });
  it("releases a saving lock and reloads authority after A → B → A without applying the old reply", async () => {
    let finish!: (reply: GoalReply) => void;
    read().mockResolvedValue({ ok: true, view: active("原目标", 1) });
    write().mockImplementation(
      () =>
        new Promise<GoalReply>((r) => {
          finish = r;
        }),
    );
    const { rerender } = render(<Host />);
    await open();
    fireEvent.change(text(), { target: { value: "我提交的修改" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    rerender(<Host target="b" />);
    rerender(<Host />);
    read().mockResolvedValue({ ok: true, view: active("最新权威状态", 3) });
    await act(async () => finish({ ok: true, view: active("旧写入结果", 2) }));
    await open();
    expect(screen.queryByText("正在保存目标…")).toBeNull();
    expect(screen.getByRole("region", { name: "当前目标" })).toHaveTextContent(
      "最新权威状态",
    );
    expect(text()).toHaveValue("我提交的修改");
    expect(screen.getByRole("button", { name: "保存修改" })).not.toBeDisabled();
  });
  it("requires an explicit damage recovery choice and keeps recovery failure visible", async () => {
    read().mockResolvedValue({ ok: true, view: { ...empty(), damaged: true } });
    write().mockResolvedValue({ ok: false, reason: "storage" });
    render(<Host />);
    await open();
    expect(screen.queryByRole("textbox")).toBeNull();
    const reset = screen.getByRole("button", { name: "确认重置" });
    expect(reset).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "保留原数据并重置目标记录" }),
    );
    fireEvent.click(reset);
    await screen.findByText(/目标没有保存/);
    expect(write()).toHaveBeenCalledWith("a", 0, { type: "reset" });
    expect(
      screen.getByRole("region", { name: "恢复目标记录" }),
    ).toBeInTheDocument();
  });
  it("uses the chat bridge and reports a full goal history without losing the text", async () => {
    const update = vi.fn(
      async (): Promise<GoalReply> => ({
        ok: false,
        reason: "history_full",
        view: empty(),
      }),
    );
    mock.bridge.getChatGoal = read();
    mock.bridge.updateChatGoal = update;
    render(<Host scope="chat" />);
    await open();
    fireEvent.change(text(), { target: { value: "新目标" } });
    fireEvent.click(screen.getByRole("button", { name: "设置目标" }));
    await screen.findByText(/历史已达到 1000 条/);
    expect(update).toHaveBeenCalledWith("a", 0, {
      type: "set",
      text: "新目标",
    });
    expect(write()).not.toHaveBeenCalled();
    expect(text()).toHaveValue("新目标");
  });
});
