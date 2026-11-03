import type { PlanReply, PlanView } from "@herta/core";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  bridge: {} as Record<string, unknown>,
  changed: vi.fn(),
  apply: vi.fn(),
}));
vi.mock("../context/HertaBridgeContext.js", () => ({
  useHertaBridge: () => ({ bridge: mock.bridge }),
}));

import { PlanPanel, PlanStrip, usePlanController } from "./PlanPanel.js";

const empty = (): PlanView => ({
  locked: false,
  state: {
    revision: 0,
    active: false,
    previousMode: null,
    plan: null,
    history: [],
  },
});
const active = (
  text = "先核对文件再给建议",
  revision = 1,
  full = false,
): PlanView => ({
  locked: true,
  state: {
    revision,
    active: true,
    previousMode: full ? "full-access" : "workspace-edit",
    history: [],
    plan: text
      ? {
          text,
          revision,
          source: "model",
          updatedAt: "2026-11-01T00:00:00.000Z",
          turnId: "turn-one",
        }
      : null,
  },
});
const inactive = (view = active()): PlanView => ({
  ...view,
  locked: false,
  state: {
    ...view.state,
    active: false,
    previousMode: null,
    revision: view.state.revision + 1,
  },
});
const read = () => mock.bridge.getSessionPlan as ReturnType<typeof vi.fn>;
const write = () => mock.bridge.updateSessionPlan as ReturnType<typeof vi.fn>;
function Host({
  target = "a",
  busy = false,
  shown = true,
}: {
  target?: string | null;
  busy?: boolean;
  shown?: boolean;
}) {
  const plan = usePlanController(
    target,
    busy,
    shown,
    mock.changed,
    (id) => (text) => {
      return mock.apply(text, id) !== false;
    },
  );
  return (
    <>
      <button type="button" onClick={plan.open}>
        查看面板
      </button>
      <button type="button" onClick={() => void plan.toggle()}>
        切换计划
      </button>
      <output>{plan.locked ? "权限锁定" : "权限可选"}</output>
      <PlanStrip plan={plan} />
      <PlanPanel plan={plan} />
    </>
  );
}
async function open() {
  const button = screen.getByRole("button", { name: "查看面板" });
  button.focus();
  fireEvent.click(button);
  await waitFor(() => expect(screen.queryByText("正在读取计划…")).toBeNull());
  return button;
}
const field = () => screen.getByRole("textbox", { name: "计划内容" });
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  mock.changed.mockReset();
  mock.apply.mockReset();
  mock.bridge = {
    getSessionPlan: vi.fn(
      async (): Promise<PlanReply> => ({ ok: true, view: empty() }),
    ),
    updateSessionPlan: vi.fn(
      async (): Promise<PlanReply> => ({ ok: true, view: active("") }),
    ),
  };
});
describe("workbench /plan controller and panel", () => {
  it("toggles into read-only planning and leaves through an explicit command without sending", async () => {
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "切换计划" }));
    const panel = await screen.findByRole("dialog", { name: "计划" });
    await within(panel).findByText("计划模式中 · 只读");
    expect(write()).toHaveBeenCalledWith("a", 0, { type: "enter" });
    expect(within(panel).getAllByRole("status")).toHaveLength(1);
    expect(within(panel).queryByText("已进入计划模式，当前只读。")).toBeNull();
    expect(screen.getByText("权限锁定")).toBeInTheDocument();
    read().mockResolvedValue({ ok: true, view: active() });
    write().mockResolvedValue({
      ok: true,
      view: inactive(),
      restoredMode: "workspace-edit",
    });
    fireEvent.click(screen.getByRole("button", { name: "切换计划" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(write()).toHaveBeenLastCalledWith("a", 1, { type: "exit" });
    expect(mock.apply).not.toHaveBeenCalled();
  });
  it("retains full-access exit confirmation until the owner confirms; cancellation stays locked", async () => {
    const view = active("full plan", 3, true);
    read().mockResolvedValue({ ok: true, view });
    write()
      .mockResolvedValueOnce({
        ok: false,
        reason: "confirmation_required",
        view,
      })
      .mockResolvedValueOnce({
        ok: false,
        reason: "confirmation_required",
        view,
      })
      .mockResolvedValueOnce({
        ok: true,
        view: inactive(view),
        restoredMode: "workspace-edit",
      });
    render(<Host />);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "退出计划模式" }));
    await screen.findByRole("region", { name: "完全访问确认" });
    fireEvent.click(screen.getByRole("button", { name: "取消切换" }));
    expect(write()).toHaveBeenCalledTimes(1);
    expect(screen.getByText("权限锁定")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "退出计划模式" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "确认完全访问" }),
    );
    await screen.findByText("已退出计划模式。当前权限：工作区编辑。");
    expect(write()).toHaveBeenLastCalledWith("a", 3, {
      type: "exit",
      confirmFullAccess: true,
    });
    expect(mock.apply).not.toHaveBeenCalled();
  });
  it("only applies the authoritative saved plan after a successful exit, and supports already-exited plans", async () => {
    const view = active();
    read().mockResolvedValue({ ok: true, view });
    let finish!: (r: PlanReply) => void;
    write().mockImplementationOnce(
      () =>
        new Promise<PlanReply>((resolve) => {
          finish = resolve;
        }),
    );
    render(<Host />);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "放入草稿" }));
    await waitFor(() => expect(write()).toHaveBeenCalledOnce());
    expect(mock.apply).not.toHaveBeenCalled();
    expect(field()).toHaveAttribute("readonly");
    await act(async () =>
      finish({
        ok: true,
        view: inactive(view),
        restoredMode: "workspace-edit",
      }),
    );
    expect(mock.apply).toHaveBeenCalledWith(view.state.plan!.text, "a");
    read().mockResolvedValue({ ok: true, view: inactive(view) });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "放入草稿" }));
    await waitFor(() => expect(mock.apply).toHaveBeenCalledTimes(2));
    expect(write()).toHaveBeenCalledOnce();
  });
  it("keeps dirty edits on conflicts and write failure; execution waits for saving the modified text", async () => {
    read().mockResolvedValue({ ok: true, view: active() });
    write()
      .mockResolvedValueOnce({
        ok: false,
        reason: "conflict",
        view: active("new authority", 2),
      })
      .mockRejectedValueOnce(Error("disk"));
    render(<Host />);
    await open();
    fireEvent.change(field(), { target: { value: "my unsaved plan" } });
    expect(screen.getByRole("button", { name: "放入草稿" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "保存计划" }));
    await screen.findByText(/计划已更新，已读取最新记录/);
    expect(field()).toHaveValue("my unsaved plan");
    fireEvent.click(screen.getByRole("button", { name: "保存计划" }));
    await screen.findByText(/计划操作没有保存/);
    expect(write()).toHaveBeenLastCalledWith("a", 2, {
      type: "save",
      text: "my unsaved plan",
    });
    expect(field()).toHaveValue("my unsaved plan");
  });
  it("refreshes a newly generated plan after a turn without replacing dirty local edits", async () => {
    read().mockResolvedValue({ ok: true, view: active() });
    const { rerender } = render(<Host />);
    await open();
    fireEvent.change(field(), { target: { value: "unfinished user edit" } });
    rerender(<Host busy />);
    expect(field()).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "保存计划" })).toBeDisabled();
    read().mockResolvedValue({ ok: true, view: active("new model plan", 2) });
    rerender(<Host />);
    await screen.findByText(/计划已更新，你尚未保存/);
    expect(field()).toHaveValue("unfinished user edit");
  });
  it("locks permissions on unknown/read-failed states even if a failed reply carries an inactive view", async () => {
    read().mockResolvedValue({ ok: false, reason: "storage", view: empty() });
    render(<Host />);
    await open();
    expect(screen.getByText("权限锁定")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("暂时无法读取计划");
    expect(screen.getByRole("button", { name: "进入计划模式" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "重新读取" }),
    ).toBeInTheDocument();
  });
  it("rejects late A → B → A writes for draft insertion and releases the returned target's lock", async () => {
    read().mockResolvedValue({ ok: true, view: active() });
    let finish!: (r: PlanReply) => void;
    write().mockImplementationOnce(
      () =>
        new Promise<PlanReply>((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender } = render(<Host />);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "放入草稿" }));
    await waitFor(() => expect(write()).toHaveBeenCalledOnce());
    rerender(<Host target="b" />);
    rerender(<Host target="a" />);
    read().mockResolvedValue({ ok: true, view: inactive() });
    await act(async () =>
      finish({ ok: true, view: inactive(), restoredMode: "workspace-edit" }),
    );
    await waitFor(() =>
      expect(screen.getByText("权限可选")).toBeInTheDocument(),
    );
    expect(mock.apply).not.toHaveBeenCalled();
    await open();
    expect(
      screen.getByRole("button", { name: "进入计划模式" }),
    ).not.toBeDisabled();
  });
  it("requires explicit damaged-state recovery and keeps read-only planning after reset", async () => {
    read().mockResolvedValue({
      ok: true,
      view: { ...empty(), locked: true, damaged: true },
    });
    render(<Host />);
    await open();
    expect(screen.getByRole("button", { name: "确认重置" })).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "保留原数据并重置计划记录" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));
    await screen.findByText("原记录已另存，当前保持计划模式与只读权限。");
    expect(write()).toHaveBeenCalledWith("a", 0, { type: "reset" });
    expect(screen.getByText("权限锁定")).toBeInTheDocument();
  });
  it("counts Unicode characters and keeps unsaved drafts over closing and hiding", async () => {
    const { rerender } = render(<Host />);
    const opener = await open();
    const text = "🌟".repeat(32000);
    fireEvent.change(field(), { target: { value: text } });
    expect(screen.getByRole("button", { name: "保存计划" })).not.toBeDisabled();
    fireEvent.change(field(), { target: { value: `${text}x` } });
    expect(screen.getByRole("button", { name: "保存计划" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "关闭计划" }));
    expect(opener).toHaveFocus();
    await open();
    expect(field()).toHaveValue(`${text}x`);
    rerender(<Host shown={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<Host />);
    await open();
    expect(field()).toHaveValue(`${text}x`);
  });
  it("keeps a single primary read-only status after saving, then clears the old feedback when reopened", async () => {
    read().mockResolvedValue({ ok: true, view: active() });
    write().mockResolvedValue({ ok: true, view: active("saved revision", 2) });
    render(<Host />);
    await open();
    fireEvent.change(field(), { target: { value: "saved revision" } });
    fireEvent.click(screen.getByRole("button", { name: "保存计划" }));
    const panel = screen.getByRole("dialog", { name: "计划" });
    await within(panel).findByText("计划模式中 · 只读 · 已保存");
    expect(within(panel).getAllByRole("status")).toHaveLength(1);
    expect(
      within(panel).getByText(
        "计划时只读；放入草稿会退出计划模式，再由你发送。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "放入草稿" })).toBeEnabled();
    expect(mock.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关闭计划" }));
    read().mockResolvedValue({ ok: true, view: active("saved revision", 2) });
    await open();
    expect(
      within(screen.getByRole("dialog", { name: "计划" })).getByRole("status"),
    ).toHaveTextContent(/^计划模式中 · 只读$/);
  });
  it("keeps the restored lower permission and changed-draft warning visible when insertion is rejected", async () => {
    const view = active("saved plan", 3, true);
    read().mockResolvedValue({ ok: true, view });
    write().mockResolvedValue({
      ok: true,
      view: inactive(view),
      restoredMode: "read-only",
    });
    mock.apply.mockReturnValue(false);
    render(<Host />);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "放入草稿" }));
    await screen.findByText(/当前权限：只读 \/ 讨论。草稿已变化，未放入计划/);
    const panel = screen.getByRole("dialog", { name: "计划" });
    expect(within(panel).getAllByRole("status")).toHaveLength(1);
    expect(
      within(panel).getByRole("button", { name: "放入草稿" }),
    ).toBeEnabled();
    expect(write()).toHaveBeenCalledWith("a", 3, { type: "exit" });
  });
});
