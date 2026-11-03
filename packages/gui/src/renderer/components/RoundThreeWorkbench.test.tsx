import type { RoundSummary } from "@herta/app-server";
import type { CompactReply, CompactView, GoalReply, PlanReply, PlanView } from "@herta/core";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderReadiness } from "../../shared/provider-settings-ipc.js";
import { App } from "../App.js";
import type { SessionSnapshot } from "../ipc/bridge-types.js";
import { createMockHertaBridge } from "../ipc/mock-bridge.js";

beforeEach(() => localStorage.clear());

it("schedules /compact without sending or changing permission and lets the user cancel (R131)", async () => {
  const mock = createMockHertaBridge();
  let view: CompactView = { revision: 0, status: "idle", scheduledPersistent: false, recap: null, recordLength: 6 };
  mock.bridge.getSessionCompact = vi.fn(async (): Promise<CompactReply> => ({ ok: true, view }));
  mock.bridge.updateSessionCompact = vi.fn(async (_id, _revision, action): Promise<CompactReply> => {
    view = { ...view, revision: view.revision + 1, status: action.type === "schedule" ? "scheduled" : "idle", ...(action.type === "cancel" ? { reason: "cancelled" } : {}) };
    return { ok: true, view };
  });
  mock.bridge.setWorkbenchPermission = vi.fn();
  render(<App bridge={mock.bridge} />); act(() => mock.emitReset(snapshot()));
  const draft = screen.getByLabelText("任务草稿 · 保存在本机");
  fireEvent.change(draft, { target: { value: "保留原草稿\n/compact" } });
  fireEvent.keyDown(draft, { key: "Enter" });
  await screen.findByText("下一回合整理先前记录");
  expect(draft).toHaveValue("保留原草稿\n");
  fireEvent.click(screen.getByRole("button", { name: "撤销整理" }));
  await screen.findByText("已撤销下一回合的整理安排。");
  expect(mock.bridge.updateSessionCompact).toHaveBeenLastCalledWith("real-session-id", 1, { type: "cancel" });
  expect(mock.calls.submitText).toEqual([]);
  expect(mock.bridge.setWorkbenchPermission).not.toHaveBeenCalled();
});

function planWorkbench(active = false) {
  const mock = createMockHertaBridge();
  let view: PlanView = { locked: active, state: { revision: 1, active, previousMode: active ? "workspace-edit" : null, plan: { text: "核对文件并完善页面", revision: 1, source: "model", updatedAt: "2026-11-01T00:00:00Z" }, history: [] } };
  mock.bridge.getSessionPlan = vi.fn(async (): Promise<PlanReply> => ({ ok: true, view }));
  mock.bridge.updateSessionPlan = vi.fn(async (_id, _revision, action): Promise<PlanReply> => {
    if (action.type === "enter" || action.type === "exit") view = { ...view, locked: action.type === "enter", state: { ...view.state, revision: view.state.revision + 1, active: action.type === "enter", previousMode: action.type === "enter" ? "workspace-edit" : null } };
    return { ok: true, view, restoredMode: "workspace-edit" };
  });
  mock.bridge.getWorkbenchPermission = vi.fn(async () => ({ sessionId: "real-session-id", projectId: "project", mode: view.locked ? "read-only" as const : "workspace-edit" as const, revision: 3, source: "project" as const, projectMode: "workspace-edit" as const, ...(view.locked ? { planLocked: true as const } : {}) }));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
  return { mock, view: () => view };
}

it("enters /plan read-only and inserts its saved plan beside the existing draft without sending (R130)", async () => {
  const { mock } = planWorkbench();
  try {
    render(<App bridge={mock.bridge} />); act(() => mock.emitReset(snapshot()));
    const draft = screen.getByLabelText("任务草稿 · 保存在本机");
    fireEvent.change(draft, { target: { value: "/plan" } }); fireEvent.keyDown(draft, { key: "Enter" });
    const panel = await screen.findByRole("dialog", { name: "计划" });
    await within(panel).findByText("计划模式中 · 只读");
    expect(screen.getByLabelText("权限档位")).toBeDisabled();
    expect(screen.getByLabelText("权限档位")).toHaveValue("read-only");
    expect(screen.getByLabelText("权限应用范围")).toBeDisabled();
    fireEvent.click(within(panel).getByRole("button", { name: "关闭计划" }));
    fireEvent.change(draft, { target: { value: "保留这段补充" } });
    fireEvent.click(screen.getByRole("button", { name: "查看计划" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "放入草稿" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "放入草稿" }));
    await waitFor(() => expect(draft).toHaveValue("保留这段补充\n\n按以下计划处理：\n核对文件并完善页面"));
    await waitFor(() => expect(screen.getByLabelText("权限档位")).toBeEnabled());
    expect(mock.calls.submitText).toEqual([]); expect(mock.calls.continueInterrupted).toBe(0);
  } finally {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  }
});

it.each(["reading", "exiting", "confirming"] as const)("keeps a newer composer draft intact while plan application is %s (R130)", async (phase) => {
  const { mock, view } = planWorkbench(true);
  try {
    render(<App bridge={mock.bridge} />); act(() => mock.emitReset(snapshot()));
    const draft = screen.getByLabelText("任务草稿 · 保存在本机");
    fireEvent.change(draft, { target: { value: "原来的意图" } });
    fireEvent.click(await screen.findByRole("button", { name: "查看计划" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "放入草稿" })).toBeEnabled());
    let finish!: (reply: PlanReply) => void;
    const pending = new Promise<PlanReply>(resolve => { finish = resolve; });
    if (phase === "reading") vi.mocked(mock.bridge.getSessionPlan!).mockReturnValueOnce(pending);
    else if (phase === "exiting") vi.mocked(mock.bridge.updateSessionPlan!).mockReturnValueOnce(pending);
    else vi.mocked(mock.bridge.updateSessionPlan!).mockResolvedValueOnce({ ok: false, reason: "confirmation_required", view: view() });
    fireEvent.click(screen.getByRole("button", { name: "放入草稿" }));
    if (phase === "exiting") await waitFor(() => expect(mock.bridge.updateSessionPlan).toHaveBeenCalledOnce());
    if (phase === "confirming") await screen.findByRole("region", { name: "完全访问确认" });
    // Changing back to the same text is still a new editing intent.
    fireEvent.change(draft, { target: { value: "新的意图" } });
    fireEvent.change(draft, { target: { value: "原来的意图" } });
    if (phase === "confirming") fireEvent.click(screen.getByRole("button", { name: "确认完全访问" }));
    else await act(async () => finish({ ok: true, view: { ...view(), locked: false, state: { ...view().state, active: false, previousMode: null } }, restoredMode: "workspace-edit" }));
    await screen.findByText(/草稿已变化，未放入计划/);
    expect(draft).toHaveValue("原来的意图");
    expect(mock.calls.submitText).toEqual([]);
  } finally {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  }
});

it("routes a damaged-goal send failure to the goal recovery panel instead of model settings (R129)", async () => {
  const mock = createMockHertaBridge();
  mock.bridge.getSessionGoal = vi.fn(
    async (): Promise<GoalReply> => ({
      ok: true,
      view: {
        state: { revision: 0, active: null, history: [] },
        damaged: true,
      },
    }),
  );
  mock.bridge.updateSessionGoal = vi.fn(
    async (): Promise<GoalReply> => ({ ok: false, reason: "storage" }),
  );
  mock.bridge.submitText = vi.fn(async () => ({
    failure: {
      code: "goal-damaged" as const,
      stage: "configuration" as const,
      action: "goal" as const,
      message: "目标记录无法读取，请先恢复。",
    },
  }));
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  try {
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    const draft = screen.getByLabelText("任务草稿 · 保存在本机");
    fireEvent.change(draft, { target: { value: "保留这条草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const card = await screen.findByRole("alert");
    expect(
      within(card).queryByRole("button", { name: "完成配置 / 验证模型" }),
    ).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "查看目标" }));
    const panel = await screen.findByRole("dialog", { name: "目标" });
    expect(
      await within(panel).findByRole("region", { name: "恢复目标记录" }),
    ).toBeInTheDocument();
    expect(draft).toHaveValue("保留这条草稿");
  } finally {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  }
});

it("opens the goal command for the current task and saves without sending or changing permission (R129)", async () => {
  const mock = createMockHertaBridge();
  mock.bridge.getSessionGoal = vi.fn(
    async (): Promise<GoalReply> => ({
      ok: true,
      view: { state: { revision: 0, active: null, history: [] } },
    }),
  );
  mock.bridge.updateSessionGoal = vi.fn(
    async (): Promise<GoalReply> => ({
      ok: true,
      view: {
        state: {
          revision: 1,
          active: {
            text: "完成主页",
            status: "active",
            setAt: "2026-11-01T00:00:00Z",
            revision: 1,
          },
          history: [],
        },
      },
    }),
  );
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  try {
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    const draft = screen.getByLabelText("任务草稿 · 保存在本机");
    fireEvent.change(draft, { target: { value: "/mubiao" } });
    fireEvent.keyDown(draft, { key: "Enter" });
    const panel = await screen.findByRole("dialog", { name: "目标" });
    expect(draft).toHaveValue("");
    fireEvent.change(within(panel).getByRole("textbox", { name: "目标内容" }), {
      target: { value: "完成主页" },
    });
    const save = within(panel).getByRole("button", { name: "设置目标" });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);
    await within(panel).findByText("目标已保存。");
    expect(mock.bridge.updateSessionGoal).toHaveBeenCalledWith(
      "real-session-id",
      0,
      { type: "set", text: "完成主页" },
    );
    expect(screen.getByRole("region", { name: "当前目标" })).toHaveTextContent(
      "完成主页",
    );
    expect(mock.calls.submitText).toEqual([]);
  } finally {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  }
});

const snapshot = (id = "real-session-id"): SessionSnapshot => ({
  sessionId: id,
  workspaceRoot: "C:\\黑塔 实验室",
  backendWorkspace: "C:\\黑塔 实验室",
  backendWorkspaceIsDefault: false,
  overlay: null,
  record: [],
});
describe("round three bridge integration (deterministic UI, not real API evidence)", () => {
  it("clears accepted text before the turn finishes and preserves a new draft", async () => {
    const mock = createMockHertaBridge();
    let finish!: (value: { turnId: string }) => void;
    mock.bridge.submitText = vi.fn(() => new Promise<{ turnId: string }>(resolve => { finish = resolve; }));
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    const input = screen.getByLabelText("任务草稿 · 保存在本机");
    fireEvent.change(input, { target: { value: "first request" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(mock.bridge.submitText).toHaveBeenCalled());
    act(() => mock.emitReset({ ...snapshot(), record: [{ kind: "user", text: "first request" }] }));
    await waitFor(() => expect(input).toHaveValue(""));
    fireEvent.change(input, { target: { value: "next request" } });
    await act(async () => finish({ turnId: "turn" }));
    expect(input).toHaveValue("next request");
  });
  it("restores an accepted draft when the turn then fails, but never over new typing (R65)", async () => {
    const mock = createMockHertaBridge();
    const failure = { failure: { code: "stream-interrupted" as const, message: "回复流中断或格式异常。", stage: "stream" as const, action: "retry" as const } };
    let finish!: (value: typeof failure) => void;
    mock.bridge.submitText = vi.fn(() => new Promise<typeof failure>(resolve => { finish = resolve; }));
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    const input = screen.getByLabelText("任务草稿 · 保存在本机");
    fireEvent.change(input, { target: { value: "first request" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(mock.bridge.submitText).toHaveBeenCalled());
    act(() => mock.emitReset({ ...snapshot(), record: [{ kind: "user", text: "first request" }] }));
    await waitFor(() => expect(input).toHaveValue(""));
    await act(async () => finish(failure));
    expect(screen.getByRole("alert")).toHaveTextContent("草稿保留");
    expect(input).toHaveValue("first request");
    expect(localStorage.getItem("the-herta.draft.session.real-session-id")).toBe("first request");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: "second request" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(mock.bridge.submitText).toHaveBeenCalledTimes(2));
    act(() => mock.emitReset({ ...snapshot(), record: [{ kind: "user", text: "first request" }, { kind: "user", text: "second request" }] }));
    await waitFor(() => expect(input).toHaveValue(""));
    fireEvent.change(input, { target: { value: "typed meanwhile" } });
    await act(async () => finish(failure));
    expect(input).toHaveValue("typed meanwhile");
  });
  it("shows a command exit row in Chinese from its structured digest (R67)", async () => {
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    act(() =>
      mock.emitReset({
        ...snapshot(),
        record: [
          { kind: "user", text: "run it" },
          { kind: "system", label: "差分协处理器", body: "↳ exit 0 · 1 lines", digest: { kind: "text", text: "↳ exit 0 · 1 lines", exitCode: 0, lineCount: 1 }, evidenceDetail: "↳ 输出:\n2" },
          { kind: "system", label: "差分协处理器", body: "↳ signal SIGTERM · 0 lines", digest: { kind: "text", text: "↳ signal SIGTERM · 0 lines" }, evidenceDetail: "↳ 输出:\n" },
        ],
      }),
    );
    expect(await screen.findByText("↳ 退出 0 · 1 行")).toBeInTheDocument();
    expect(screen.queryByText("↳ exit 0 · 1 lines")).toBeNull();
    expect(screen.getByText("↳ signal SIGTERM · 0 lines")).toBeInTheDocument();
  });
  it("changes a relocated task directory only after an explicit idle action", async () => {
    const mock = createMockHertaBridge();
    mock.bridge.getProjectNavigation = vi.fn(async () => ({
      schemaVersion: 1 as const,
      revision: 2,
      projects: [
        {
          projectId: "stable-project",
          path: "C:\\新目录",
          name: "项目",
          alias: null,
          pinned: false,
          pinOrder: 0,
          expanded: true,
          removed: false,
          permissionMode: "workspace-edit" as const,
        },
      ],
      tasks: [
        {
          sessionId: "moved-task",
          projectId: "stable-project",
          pinned: false,
          pinOrder: 0,
          recycled: false,
          permissionMode: null,
        },
      ],
    }));
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot("moved-task")));
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "使用项目新位置",
        }),
      ).toBeInTheDocument(),
    );
    expect(mock.calls.setWorkspace).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "使用项目新位置" }));
    await waitFor(() =>
      expect(mock.calls.setWorkspace).toEqual([["moved-task", "C:\\新目录"]]),
    );
    expect(mock.calls.submitText).toEqual([]);
    expect(
      screen.getByRole("region", { name: "项目位置已变更" }),
    ).toBeInTheDocument();
  });
  it("checks the actual session binding, preserves an unready draft and refreshes after settings without automatic retry", async () => {
    const mock = createMockHertaBridge();
    let ready = false;
    mock.bridge.getProviderReadiness = vi.fn(
      async (sessionId) =>
        ({
          sessionId: sessionId ?? null,
          scope: "session",
          ready,
          ...(!ready
            ? {
                issue: {
                  code: "model-unverified",
                  message: "当前任务覆盖模型尚未验证",
                  action: "validate",
                  role: "executor",
                },
              }
            : {}),
        }) as ProviderReadiness,
    );
    mock.bridge.submitText = vi.fn(async () => ({ turnId: "explicit-retry" }));
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot("overridden-session")));
    await waitFor(() =>
      expect(mock.bridge.getProviderReadiness).toHaveBeenCalledWith(
        "overridden-session",
      ),
    );
    const draft = screen.getByLabelText("任务草稿 · 保存在本机");
    fireEvent.change(draft, { target: { value: "必须保留的任务" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "当前任务覆盖模型尚未验证",
      ),
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(mock.bridge.submitText).not.toHaveBeenCalled();
    expect(draft).toHaveValue("必须保留的任务");
    fireEvent.click(
      screen.getByRole("button", { name: "完成配置 / 验证模型" }),
    );
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    ready = true;
    fireEvent.click(screen.getByRole("button", { name: "返回任务" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /选择模型/ }),
      ).toBeInTheDocument(),
    );
    expect(mock.bridge.submitText).not.toHaveBeenCalled();
    expect(draft).toHaveValue("必须保留的任务");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(mock.bridge.submitText).toHaveBeenCalledExactlyOnceWith(
        "必须保留的任务", undefined, "overridden-session",
      ),
    );
  });
  it("shows a safe authentication failure once and preserves the draft without retry", async () => {
    const mock = createMockHertaBridge();
    mock.bridge.getProviderReadiness = vi.fn(async (sessionId) => ({
      ready: true,
      scope: "global" as const,
      sessionId: sessionId ?? null,
    }));
    mock.bridge.submitText = vi.fn(async () => ({
      failure: {
        code: "authentication" as const,
        message: "服务拒绝鉴权，请重新保存凭据",
        stage: "request" as const,
        status: 401,
        action: "credential" as const,
      },
    }));
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    fireEvent.change(screen.getByLabelText("任务草稿 · 保存在本机"), {
      target: { value: "鉴权失败草稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("服务拒绝鉴权"),
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByLabelText("任务草稿 · 保存在本机")).toHaveValue(
      "鉴权失败草稿",
    );
    expect(mock.bridge.submitText).toHaveBeenCalledTimes(1);
  });
  it("requires a separate user confirmation before dispatching a full access change", async () => {
    const mock = createMockHertaBridge();
    const permission = {
      sessionId: "real-session-id",
      projectId: "project",
      mode: "workspace-edit" as const,
      revision: 3,
      source: "project" as const,
      projectMode: "workspace-edit" as const,
    };
    mock.bridge.getWorkbenchPermission = vi.fn(async () => permission);
    mock.bridge.setWorkbenchPermission = vi.fn(async () => ({
      ...permission,
      mode: "full-access" as const,
      revision: 4,
    }));
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    await waitFor(() =>
      expect(screen.getByLabelText("权限档位")).toBeEnabled(),
    );
    fireEvent.change(screen.getByLabelText("权限档位"), {
      target: { value: "full-access" },
    });
    expect(mock.bridge.setWorkbenchPermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消切换" }));
    expect(mock.bridge.setWorkbenchPermission).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("权限档位"), {
      target: { value: "full-access" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认完全访问" }));
    await waitFor(() =>
      expect(mock.bridge.setWorkbenchPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "real-session-id",
          mode: "full-access",
          expectedRevision: 3,
          confirmFullAccess: true,
        }),
      ),
    );
    expect(mock.calls.submitText).toEqual([]);
    expect(mock.calls.continueInterrupted).toBe(0);
  });
  it("closes the permission scope popover on Escape and returns focus to its toggle (R63)", async () => {
    const mock = createMockHertaBridge();
    mock.bridge.getWorkbenchPermission = vi.fn(async () => ({
      sessionId: "real-session-id",
      projectId: "project",
      mode: "workspace-edit" as const,
      revision: 3,
      source: "project" as const,
      projectMode: "workspace-edit" as const,
    }));
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    const select = await screen.findByLabelText("权限应用范围");
    const details = select.closest("details") as HTMLDetailsElement;
    details.open = true;
    select.focus();
    fireEvent.keyDown(select, { key: "Escape", keyCode: 229 });
    expect(details.open).toBe(true);
    fireEvent.keyDown(select, { key: "Escape" });
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(details.querySelector("summary"));
  });
  it("does not display an old task's late submit rejection in the newly selected task", async () => {
    const mock = createMockHertaBridge({
      listSessionsResult: [
        {
          sessionId: "b",
          workspaceRoot: "C:\\test",
          startedAt: "2026-10-04",
          lastActivityAt: "2026-10-04",
          title: "任务 B",
        },
      ],
    });
    let rejectOld!: (error: Error) => void;
    mock.bridge.submitText = vi.fn(
      () =>
        new Promise<{ turnId: string }>((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    mock.bridge.openSession = vi.fn(async () => {
      const value = snapshot("b");
      mock.emitReset(value);
      return value;
    });
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot("a")));
    fireEvent.change(screen.getByLabelText("任务草稿 · 保存在本机"), {
      target: { value: "A 的请求" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(mock.bridge.submitText).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "任务 B" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "任务 B" }));
    fireEvent.click(screen.getByRole("button", { name: "停止并切换" }));
    await waitFor(() =>
      expect(screen.getByText(/任务 ID：b/)).toBeInTheDocument(),
    );
    await act(async () => rejectOld(new Error("late old turn")));
    expect(screen.queryByText(/请求失败。文本保留/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("任务草稿 · 保存在本机")).toHaveValue("");
    expect(localStorage.getItem("the-herta.draft.session.a")).toBe("A 的请求");
  });
  it("requires explicit stop confirmation for switching during output and preserves the source draft", async () => {
    const mock = createMockHertaBridge({
      listSessionsResult: [
        {
          sessionId: "b",
          workspaceRoot: "C:\\test",
          startedAt: "2026-10-04",
          lastActivityAt: "2026-10-04",
          title: "任务 B",
        },
      ],
    });
    mock.bridge.openSession = vi.fn(async () => {
      const value = snapshot("b");
      mock.emitReset(value);
      return value;
    });
    render(<App bridge={mock.bridge} />);
    act(() => {
      mock.emitReset(snapshot("a"));
      mock.emitTurn({ kind: "started", turnId: "a-turn" });
    });
    const draft = screen.getByLabelText("任务草稿 · 保存在本机");
    fireEvent.change(draft, { target: { value: "A 未发送草稿" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "任务 B" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "任务 B" }));
    expect(mock.bridge.openSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "留在当前任务" }));
    expect(mock.bridge.openSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "任务 B" }));
    fireEvent.click(screen.getByRole("button", { name: "停止并切换" }));
    await waitFor(() =>
      expect(mock.bridge.openSession).toHaveBeenCalledWith("b", {
        interruptActiveSessionId: "a",
      }),
    );
    expect(localStorage.getItem("the-herta.draft.session.a")).toBe(
      "A 未发送草稿",
    );
    expect(draft).toHaveValue("");
  });
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });
  it("creates a session with both project paths, sends real bridge text and preserves IME/newlines", async () => {
    const mock = createMockHertaBridge({
      pickWorkspaceResult: "C:\\黑塔 实验室",
    });
    mock.bridge.createSession = vi.fn(async () => {
      const result = snapshot();
      mock.emitReset(result);
      return result;
    });
    render(<App bridge={mock.bridge} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "打开项目文件夹" })[0]!,
    );
    await waitFor(() =>
      expect(screen.getByTitle("C:\\黑塔 实验室")).toBeInTheDocument(),
    );
    const input = screen.getByLabelText("任务草稿 · 保存在本机");
    fireEvent.change(input, { target: { value: "中文任务\n第二行" } });
    fireEvent.keyDown(input, {
      key: "Enter",
      ctrlKey: true,
      isComposing: true,
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mock.calls.submitText).toEqual([]);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(mock.calls.submitText).toEqual(["中文任务\n第二行"]),
    );
    expect(mock.bridge.createSession).toHaveBeenCalledWith(
      {
        workspaceRoot: "C:\\黑塔 实验室",
        backendWorkspace: "C:\\黑塔 实验室",
        lang: "zh",
      },
      undefined,
    );
    expect(screen.getByText(/任务 ID：real-session-id/)).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveValue(""));
  });
  it("keeps failed initial submit text in the new task instead of losing the welcome draft", async () => {
    const mock = createMockHertaBridge();
    mock.bridge.createSession = vi.fn(async () => {
      const result = snapshot();
      mock.emitReset(result);
      return result;
    });
    mock.bridge.submitText = vi.fn(async () => {
      throw new Error("missing provider");
    });
    render(<App bridge={mock.bridge} />);
    fireEvent.change(screen.getByLabelText("任务草稿 · 保存在本机"), {
      target: { value: "请保留失败文本" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("请求失败"),
    );
    expect(screen.getByLabelText("任务草稿 · 保存在本机")).toHaveValue(
      "请保留失败文本",
    );
    expect(
      localStorage.getItem("the-herta.draft.session.real-session-id"),
    ).toBe("请保留失败文本");
  });
  it("renders actor streams, durable records and tool results without exposing thoughts", () => {
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    act(() => {
      mock.emitReset(snapshot());
      mock.emitTurn({ kind: "started", turnId: "turn-real" });
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "assistant.delta",
          layer: "actor",
          text: "真实流式文字",
        },
      });
      mock.emitAgent({
        kind: "agent",
        event: { type: "turn.started", layer: "backend", userText: "检查" },
      });
      mock.emitLive({
        startedOps: 1,
        views: [
          {
            id: "tool-real",
            tool: "run_command",
            stage: "running",
            started: true,
            done: false,
            streams: true,
            mode: "text",
            tail: "actual stdout",
            lines: 1,
          },
        ],
      });
    });
    expect(screen.getByText("真实流式文字")).toBeInTheDocument();
    expect(screen.getByText("actual stdout")).toBeInTheDocument();
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "record-1",
        block: { kind: "herta", surface: "thought", text: "PRIVATE THOUGHT" },
      });
      mock.emitRecord({
        kind: "block",
        blockId: "record-2",
        block: {
          kind: "system",
          label: "系统",
          body: "命令结束",
          evidenceDetail: "退出码 0",
        },
      });
      mock.emitRecord({
        kind: "block",
        blockId: "record-3",
        block: { kind: "herta", surface: "speech", text: "真实结论" },
      });
      mock.emitTurn({ kind: "finished", turnId: "turn-real" });
    });
    expect(screen.queryByText("PRIVATE THOUGHT")).not.toBeInTheDocument();
    expect(screen.getByText("真实结论")).toBeInTheDocument();
    expect(screen.queryByText("退出码 0")).not.toBeInTheDocument();
    const evidence = screen.getByText("执行结果与证据").closest("details")!;
    evidence.open = true;
    fireEvent(evidence, new Event("toggle"));
    expect(screen.getByText("退出码 0")).toBeInTheDocument();
  });
  it("uses actual approval request IDs, disables while resolving, and cancels through bridge", async () => {
    const mock = createMockHertaBridge();
    let resolve: ((value: { ok: true }) => void) | undefined;
    mock.bridge.resolveApproval = vi.fn(
      () =>
        new Promise<{ ok: true }>((done) => {
          resolve = done;
        }),
    );
    render(<App bridge={mock.bridge} />);
    act(() => {
      mock.emitReset(snapshot());
      mock.emitTurn({ kind: "started", turnId: "turn-real" });
      mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "request-real",
          tool: "write_new_file",
          summary: "写入文件",
          risk: "workspace_write",
          diff: "+actual pending content",
        },
      });
    });
    expect(screen.getByText("+actual pending content")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(mock.bridge.resolveApproval).toHaveBeenCalledWith({
      requestId: "request-real",
      decision: "deny",
      persistence: "once",
    });
    expect(screen.getByRole("button", { name: "允许本次" })).toBeDisabled();
    fireEvent.click(screen.getAllByRole("button", { name: "取消本轮" })[0]!);
    await waitFor(() => expect(mock.calls.interrupt).toHaveLength(1));
    await act(async () => resolve?.({ ok: true }));
    expect(screen.getByRole("button", { name: "拒绝" })).toBeDisabled();
    act(() =>
      mock.emitOverlay({ kind: "resolved", requestId: "request-real" }),
    );
    expect(
      screen.queryByRole("button", { name: "允许本次" }),
    ).not.toBeInTheDocument();
  });
  it("confirms copying the project path and says when the clipboard refuses (R44)", async () => {
    const mock = createMockHertaBridge();
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      render(<App bridge={mock.bridge} />);
      act(() => mock.emitReset(snapshot()));
      fireEvent.click(await screen.findByText("项目位置"));
      fireEvent.click(screen.getByRole("button", { name: "复制项目路径" }));
      const done = await screen.findByRole("button", { name: "已复制项目路径" });
      expect(writeText).toHaveBeenCalledWith("C:\\黑塔 实验室");
      fireEvent.click(done);
      expect(
        await screen.findByRole("button", {
          name: "未能复制，请手动选择上方路径",
        }),
      ).toBeInTheDocument();
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
  it("opens history, derives recent projects, renames and exposes session binding scope", async () => {
    const mock = createMockHertaBridge({
      listSessionsResult: [
        {
          sessionId: "history-id",
          workspaceRoot: "C:\\历史项目",
          startedAt: "2026-10-01",
          lastActivityAt: "2026-10-03",
          title: "旧任务",
        },
      ],
      sessionActions: {},
    });
    mock.bridge.openSession = vi.fn(async () => {
      const result = {
        ...snapshot("history-id"),
        backendWorkspace: "C:\\历史项目",
        record: [{ kind: "user" as const, text: "保存的旧文本" }],
      };
      mock.emitReset(result);
      return result;
    });
    render(<App bridge={mock.bridge} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "旧任务" }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "历史项目" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "旧任务" }));
    await waitFor(() =>
      expect(screen.getByText("保存的旧文本")).toBeInTheDocument(),
    );
    expect(mock.calls.submitText).toEqual([]);
    fireEvent.click(screen.getByLabelText("任务操作 旧任务"));
    fireEvent.click(screen.getByRole("button", { name: "重命名 旧任务" }));
    fireEvent.change(screen.getByLabelText("任务名称"), {
      target: { value: "新名称" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await waitFor(() =>
      expect(mock.calls.renameSession).toEqual([["history-id", "新名称"]]),
    );
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: "当前任务覆盖" }),
      ).toBeInTheDocument(),
    );
  });
  it("keeps session drafts separate and rejects corrupted history without replay", async () => {
    const mock = createMockHertaBridge({
      listSessionsResult: [
        {
          sessionId: "bad-id",
          workspaceRoot: "/bad",
          startedAt: "2026-10-01",
          lastActivityAt: "2026-10-03",
          title: "损坏历史",
        },
      ],
      openSessionResult: { openError: { code: "corrupt-line", line: 4 } },
    });
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot("a")));
    fireEvent.change(screen.getByLabelText("任务草稿 · 保存在本机"), {
      target: { value: "A 草稿" },
    });
    act(() => mock.emitReset(snapshot("b")));
    expect(screen.getByLabelText("任务草稿 · 保存在本机")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("任务草稿 · 保存在本机"), {
      target: { value: "B 草稿" },
    });
    act(() => mock.emitReset(snapshot("a")));
    expect(screen.getByLabelText("任务草稿 · 保存在本机")).toHaveValue(
      "A 草稿",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "损坏历史" }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "损坏历史" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "corrupt-line，第 4 行",
      ),
    );
    expect(screen.getByText(/任务 ID：a/)).toBeInTheDocument();
    expect(mock.calls.submitText).toEqual([]);
  });
  it("jails file/diff reads to the active session and drops a late response after switching", async () => {
    const mock = createMockHertaBridge();
    let resolve:
      | ((value: {
          ok: true;
          content: string;
          truncated: boolean;
          size: number;
          relative: string;
        }) => void)
      | undefined;
    mock.bridge.readWorkspaceFile = vi.fn(
      () =>
        new Promise<{
          ok: true;
          content: string;
          truncated: boolean;
          size: number;
          relative: string;
        }>((done) => {
          resolve = done;
        }),
    );
    mock.bridge.readWorkspaceDiff = vi.fn(async () => ({
      ok: true as const,
      diff: {
        path: "文件.ts",
        untracked: false,
        missing: false,
        patch: "+磁盘内容",
        patchTruncated: false,
        added: 1,
        deleted: 0,
      },
    }));
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot("a")));
    fireEvent.click(screen.getByRole("button", { name: "工作区审阅" }));
    fireEvent.change(screen.getByLabelText("工作区内相对路径"), {
      target: { value: "文件.ts" },
    });
    fireEvent.click(screen.getByRole("button", { name: "读取磁盘 diff" }));
    await waitFor(() =>
      expect(screen.getByText("+磁盘内容")).toBeInTheDocument(),
    );
    expect(mock.bridge.readWorkspaceDiff).toHaveBeenCalledWith("a", "文件.ts");
    fireEvent.click(screen.getByRole("button", { name: "读取文件" }));
    act(() => mock.emitReset(snapshot("b")));
    await act(async () =>
      resolve?.({
        ok: true,
        content: "A PRIVATE FILE",
        truncated: false,
        size: 4,
        relative: "文件.ts",
      }),
    );
    expect(screen.queryByText("A PRIVATE FILE")).not.toBeInTheDocument();
  });
  it("keeps demos apart from real records and never executes sample approvals", () => {
    window.history.replaceState(null, "", "?demo=approval");
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    window.history.replaceState(null, "", "/");
    act(() =>
      mock.emitReset({
        ...snapshot(),
        record: [{ kind: "user", text: "真实任务记录" }],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "审批样例" }));
    expect(screen.queryByText("真实任务记录")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "允许本次（演示）" }));
    expect(mock.calls.resolveApproval).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "返回真实任务" }));
    expect(screen.getByText("真实任务记录")).toBeInTheDocument();
  });
  it("does not auto-resume interruption and sends a single explicit resume request", async () => {
    const mock = createMockHertaBridge();
    mock.bridge.continueInterrupted = vi.fn(async () => ({
      turnId: "continued-real",
    }));
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset({ ...snapshot(), resumable: true }));
    expect(mock.bridge.continueInterrupted).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("已完成的操作不会再执行");
    fireEvent.click(screen.getByRole("button", { name: "继续中断的任务" }));
    await waitFor(() =>
      expect(mock.bridge.continueInterrupted).toHaveBeenCalledTimes(1),
    );
    expect(mock.calls.submitText).toEqual([]);
  });
  it("preserves partial durable records and new input on failed streaming turn", () => {
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    act(() =>
      mock.emitReset({
        ...snapshot(),
        record: [
          { kind: "system", label: "系统", body: "文件已写入，等待后续检查" },
        ],
      }),
    );
    fireEvent.change(screen.getByLabelText("任务草稿 · 保存在本机"), {
      target: { value: "新的说明" },
    });
    act(() => {
      mock.emitTurn({ kind: "started", turnId: "failed-real" });
      mock.emitAgent({
        kind: "agent",
        event: { type: "assistant.delta", layer: "actor", text: "未完成的流" },
      });
      mock.emitTurn({
        kind: "failed",
        turnId: "failed-real",
        error: { code: "ProviderError", message: "redacted", status: 503 },
      });
    });
    expect(screen.getByRole("alert")).toHaveTextContent("HTTP 503");
    expect(screen.getByText("文件已写入，等待后续检查")).toBeInTheDocument();
    expect(screen.getByLabelText("任务草稿 · 保存在本机")).toHaveValue(
      "新的说明",
    );
    expect(mock.calls.submitText).toEqual([]);
    expect(mock.calls.continueInterrupted).toBe(0);
  });
  it("leads the approval card with the localized reason, risk and command; IDs sit under diagnostics (R45)", async () => {
    const mock = createMockHertaBridge();
    mock.bridge.getLocale = async () => "zh" as const;
    render(<App bridge={mock.bridge} />);
    act(() => {
      mock.emitReset(snapshot());
      mock.emitTurn({ kind: "started", turnId: "ask-turn" });
      mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "request-r45",
          command: "node -e console.log(1+1)",
          tool: "run_command",
          summary: "node runs inline code the record never showed",
          risk: "workspace_write",
          code: "command_ask_interpreter",
        },
      });
    });
    const approval = screen.getByRole("region", { name: "真实执行审批" });
    expect(
      await within(approval).findByText("解释器执行脚本，请核对脚本与参数"),
    ).toBeInTheDocument();
    expect(within(approval).getByText("写入工作区")).toHaveClass(
      "herta-approval-risk",
    );
    expect(within(approval).getByText("node -e console.log(1+1)").tagName).toBe(
      "PRE",
    );
    const diagnostics = approval.querySelector(".herta-approval-diagnostics");
    expect(diagnostics).not.toHaveAttribute("open");
    expect(diagnostics).toHaveTextContent("request-r45");
    expect(diagnostics).toHaveTextContent("node runs inline code");
  });
  it("keeps approval actions outside both the growing transcript and scrollable detail body", () => {
    const mock = createMockHertaBridge();
    const { container } = render(<App bridge={mock.bridge} />);
    act(() => {
      mock.emitReset(snapshot());
      mock.emitTurn({ kind: "started", turnId: "approval-turn" });
      mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "request-fixed",
          command: "node check.mjs",
          tool: "run_command",
          summary: "检查命令",
          risk: "workspace_write",
          diff: "+pending change",
        },
      });
    });
    const approval = screen.getByRole("region", { name: "真实执行审批" });
    const content = container.querySelector(".herta-content");
    const body = approval.querySelector(".herta-approval-body");
    const allow = screen.getByRole("button", { name: "允许本次" });
    expect(content).not.toContainElement(approval);
    expect(body).toContainElement(screen.getByText("node check.mjs"));
    expect(body).not.toContainElement(allow);
    expect(approval.parentElement).toBe(content?.parentElement);
    expect(approval.nextElementSibling).toHaveClass("herta-composer");
    expect(approval.querySelector("details")).not.toHaveAttribute("open");
    act(() =>
      mock.emitRecord({
        kind: "block",
        blockId: "late-patch",
        block: {
          kind: "system",
          label: "系统",
          body: "late patch preview\n".repeat(300),
        },
      }),
    );
    expect(content).not.toContainElement(allow);
    expect(approval).toContainElement(allow);
    expect(screen.getByRole("button", { name: "拒绝" })).toBeEnabled();
    expect(approval.querySelector(".herta-actions")).toContainElement(
      screen.getAllByRole("button", { name: "取消本轮" })[0]!,
    );
  });
});
it("names Herta's replies 黑塔, as the chat does (R72)", async () => {
  const mock = createMockHertaBridge();
  render(<App bridge={mock.bridge} />);
  act(() =>
    mock.emitReset({
      ...snapshot(),
      record: [
        { kind: "user", text: "你好" },
        { kind: "herta", surface: "speech", text: "说吧，什么难题。" },
      ],
    }),
  );
  const reply = (await screen.findByText("说吧，什么难题。")).closest("article");
  expect(reply).not.toBeNull();
  expect(within(reply as HTMLElement).getByText("黑塔")).toBeInTheDocument();
  expect(within(reply as HTMLElement).queryByText("The Herta")).toBeNull();
});

describe("workbench attachments ride the message (R79)", () => {
  it("R84 audit: keeps a removed document removed while another document finishes reading", async () => {
    const mock = createMockHertaBridge({ pickAttachmentsResult: ["C:\\资料\\first.md"] });
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    await screen.findByRole("button", { name: "移除 first.md" });
    const original = mock.bridge.stageImages;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mock.bridge.stageImages = async (...args) => { await gate; return original(...args); };
    const box = screen.getByLabelText("任务草稿 · 保存在本机").closest(".herta-composer-box") as HTMLElement;
    fireEvent.drop(box, { dataTransfer: { types: ["Files"], files: [{ name: "C:\\资料\\second.md" }] } });
    await screen.findByText("second.md");
    fireEvent.click(screen.getByRole("button", { name: "移除 first.md" }));
    expect(screen.queryByRole("button", { name: "移除 first.md" })).toBeNull();
    await act(async () => { release(); });
    await screen.findByRole("button", { name: "移除 second.md" });
    expect(screen.queryByRole("button", { name: "移除 first.md" })).toBeNull();
  });
  it("shows picked files as cards, adds nothing to the task until sending, then sends both with the message", async () => {
    const mock = createMockHertaBridge({ pickAttachmentsResult: ["C:\\资料\\shot.png", "C:\\资料\\spec.md"] });
    mock.bridge.submitText = vi.fn(async () => ({ turnId: "t" }));
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    const tray = await screen.findByRole("group", { name: "待发送的附件" });
    expect(await within(tray).findByRole("button", { name: "查看图片 shot.png" })).toBeInTheDocument();
    await waitFor(() => expect(tray).toHaveTextContent("spec.md"));
    // Nothing reached the task yet, and nothing claims it did.
    expect(mock.calls.attachFiles).toEqual([]);
    expect(screen.queryByText("文件已添加到当前任务。")).toBeNull();
    fireEvent.change(screen.getByLabelText("任务草稿 · 保存在本机"), { target: { value: "看看这两个" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(mock.bridge.submitText).toHaveBeenCalled());
    expect(mock.calls.attachFiles).toEqual([["real-session-id", ["C:\\资料\\spec.md"]]]);
    expect(mock.bridge.submitText).toHaveBeenCalledWith("看看这两个", ["staged-0"], "real-session-id");
    await waitFor(() => expect(screen.queryByRole("group", { name: "待发送的附件" })).toBeNull());
  });

  it("sends nothing that was removed from the composer", async () => {
    const mock = createMockHertaBridge({ pickAttachmentsResult: ["C:\\资料\\shot.png", "C:\\资料\\spec.md"] });
    mock.bridge.submitText = vi.fn(async () => ({ turnId: "t" }));
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    const tray = await screen.findByRole("group", { name: "待发送的附件" });
    await waitFor(() => expect(tray).toHaveTextContent("spec.md"));
    fireEvent.click(within(tray).getByRole("button", { name: "移除 spec.md" }));
    fireEvent.click(within(tray).getByRole("button", { name: "移除 shot.png" }));
    expect(mock.calls.unstageImage).toEqual([["real-session-id", "staged-0"]]);
    fireEvent.change(screen.getByLabelText("任务草稿 · 保存在本机"), { target: { value: "不带附件了" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(mock.bridge.submitText).toHaveBeenCalled());
    expect(mock.calls.attachFiles).toEqual([]);
    expect(mock.bridge.submitText).toHaveBeenCalledWith("不带附件了", undefined, "real-session-id");
  });

  it("keeps a refused file as a failed card and holds the send until it is removed", async () => {
    const mock = createMockHertaBridge({
      pickAttachmentsResult: ["C:\\资料\\keys.png"],
      stageImagesResult: { ok: true, staged: [], rejected: [{ name: "keys.png", reason: "denied" }] },
    });
    mock.bridge.submitText = vi.fn(async () => ({ turnId: "t" }));
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    expect(await screen.findByText("未添加：涉及密钥或凭据，已拒收。")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("任务草稿 · 保存在本机"), { target: { value: "继续" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("还有附件没有添加成功：请重试或移除它，再发送。")).toBeInTheDocument();
    expect(mock.bridge.submitText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "移除 keys.png" }));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(mock.bridge.submitText).toHaveBeenCalledWith("继续", undefined, "real-session-id"));
  });

  it("stages a pasted screenshot as a card and sends it with the message, leaving text pastes alone (R81)", async () => {
    const mock = createMockHertaBridge();
    mock.bridge.submitText = vi.fn(async () => ({ turnId: "t" }));
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    const input = screen.getByLabelText("任务草稿 · 保存在本机");
    // A text paste carries no files: nothing is staged and the default paste stands.
    fireEvent.paste(input, { clipboardData: { files: [] } });
    expect(mock.calls.stageImages).toHaveLength(0);
    const shot = { name: "image.png", type: "image/png", arrayBuffer: async () => new Uint8Array([0x89, 0x50]).buffer };
    await act(async () => {
      fireEvent.paste(input, { clipboardData: { files: [shot, { name: "a.txt", type: "text/plain" }] } });
    });
    await waitFor(() => expect(mock.calls.stageImages).toHaveLength(1));
    const [sid, inputs] = mock.calls.stageImages[0] as [string, readonly { name?: string; bytes?: Uint8Array; path?: string }[]];
    expect(sid).toBe("real-session-id");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.name).toBe("pasted-image.png");
    expect(inputs[0]?.path).toBeUndefined();
    expect(Array.from(inputs[0]?.bytes ?? [])).toEqual([0x89, 0x50]);
    const tray = await screen.findByRole("group", { name: "待发送的附件" });
    expect(await within(tray).findByRole("button", { name: "查看图片 pasted-image.png" })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "看这张截图" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(mock.bridge.submitText).toHaveBeenCalledWith("看这张截图", ["staged-0"], "real-session-id"));
  });

  it("adds dropped files as the same cards, and refuses paste or drop while a turn runs (R81)", async () => {
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    const input = screen.getByLabelText("任务草稿 · 保存在本机");
    const box = input.closest(".herta-composer-box") as HTMLElement;
    const files = [{ name: "C:\\资料\\diagram.png" }, { name: "C:\\资料\\notes.md" }];
    fireEvent.dragEnter(box, { dataTransfer: { types: ["Files"], files } });
    expect(box).toHaveClass("is-dragover");
    await act(async () => {
      fireEvent.drop(box, { dataTransfer: { types: ["Files"], files } });
    });
    expect(box).not.toHaveClass("is-dragover");
    const tray = await screen.findByRole("group", { name: "待发送的附件" });
    expect(await within(tray).findByRole("button", { name: "查看图片 diagram.png" })).toBeInTheDocument();
    await waitFor(() => expect(tray).toHaveTextContent("notes.md"));
    expect(mock.calls.stageImages.map(([, i]) => i)).toEqual([
      [{ path: "C:\\资料\\diagram.png", name: "diagram.png" }],
      [{ path: "C:\\资料\\notes.md", name: "notes.md" }],
    ]);
    expect(mock.calls.attachFiles).toEqual([]);

    act(() => mock.emitTurn({ kind: "started", turnId: "busy-turn" }));
    const before = mock.calls.stageImages.length;
    await act(async () => {
      fireEvent.drop(box, { dataTransfer: { types: ["Files"], files: [{ name: "C:\\资料\\late.png" }] } });
    });
    expect(await screen.findByText("黑塔正在处理本轮，结束后再添加文件。")).toBeInTheDocument();
    const shot = { name: "", type: "image/png", arrayBuffer: async () => new Uint8Array([1]).buffer };
    await act(async () => {
      fireEvent.paste(input, { clipboardData: { files: [shot] } });
    });
    expect(await screen.findByText("黑塔正在处理本轮，结束后再添加图片。")).toBeInTheDocument();
    expect(mock.calls.stageImages).toHaveLength(before);
  });

  it("shows a sent message's attachment rows inside its bubble, above its text", async () => {
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    const body = "附件 shot.png · 图片 PNG · 96×64 · .herta/attachments/s/shot.png";
    act(() =>
      mock.emitReset({
        ...snapshot(),
        record: [
          { kind: "system", label: "系统", body, digest: { kind: "attachment", name: "shot.png", path: ".herta/attachments/s/shot.png", lines: 0, chars: 0, image: { format: "png", width: 96, height: 64 } } },
          { kind: "user", text: "看到了什么？" },
        ],
      }),
    );
    const text = await screen.findByText("看到了什么？");
    const bubble = text.closest("article") as HTMLElement;
    const group = within(bubble).getByRole("group", { name: "这条消息的附件" });
    expect(group.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const thumb = within(group).getByRole("button", { name: "查看图片 shot.png" });
    expect(thumb.querySelector("img")).toHaveAttribute("src", "herta-attachment://file/.herta/attachments/s/shot.png");
    // Not also a separate 系统 row.
    expect(screen.queryByText(/附件 shot\.png · 图片 PNG/)).toBeNull();
  });
});

describe("composer actions: the 快捷操作 menu and / share them (R80)", () => {
  const plugins = { revision: 1, items: [{ enabled: true, contentHash: "hash", installedAt: "today", updatedAt: "today", manifest: { schemaVersion: 1 as const, id: "local.test", name: "测试包", version: "1.0.0", description: "", actions: [{ id: "review", title: "检查", scope: "both" as const, prompt: "检查 {{request}}", inputs: [{ id: "request", label: "内容", type: "text" as const, required: true }] }] } }] };
  const draft = () => screen.getByLabelText("任务草稿 · 保存在本机");
  it("runs 附加文件 the same way from the 快捷操作 menu, from / and from the paperclip", async () => {
    const mock = createMockHertaBridge({ pickAttachmentsResult: null });
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    fireEvent.click(screen.getByRole("button", { name: "快捷操作" }));
    const common = await screen.findByRole("group", { name: "常用" });
    expect(within(common).getAllByRole("button").map((b) => b.firstChild?.textContent)).toEqual(["附加文件", "选择模型", "权限档位"]);
    fireEvent.click(within(common).getByRole("button", { name: /附加文件/ }));
    await waitFor(() => expect(mock.calls.pickAttachments).toBe(1));
    fireEvent.change(draft(), { target: { value: "/fujian" } });
    fireEvent.keyDown(draft(), { key: "Enter" });
    await waitFor(() => expect(mock.calls.pickAttachments).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    await waitFor(() => expect(mock.calls.pickAttachments).toBe(3));
    expect(draft()).toHaveValue("");
  });
  it("lists the permission level only in the workbench, and / opens a prompt action in the 快捷操作 menu to fill and preview", async () => {
    const mock = createMockHertaBridge();
    mock.bridge.promptPlugins = vi.fn(async () => ({ ok: true as const, snapshot: plugins }));
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    fireEvent.change(draft(), { target: { value: "/" } });
    const menu = screen.getByRole("listbox", { name: "指令" });
    expect(await within(menu).findByText("检查")).toBeInTheDocument();
    expect(within(menu).getByText("权限档位")).toBeInTheDocument();
    fireEvent.change(draft(), { target: { value: "/检查" } });
    fireEvent.keyDown(draft(), { key: "Enter" });
    const popover = await screen.findByRole("region", { name: "快捷操作" });
    expect(await within(popover).findByLabelText("内容 *")).toBeInTheDocument();
    expect(within(popover).getByRole("heading", { name: "检查" })).toBeInTheDocument();
    // Nothing was sent or inserted on the way: the action waits for its preview.
    expect(mock.calls.submitText).toEqual([]);
    expect(draft()).toHaveValue("");
  });
  it("says in the / menu why a command waits for a running turn, and keeps the typed command (R123)", async () => {
    const mock = createMockHertaBridge();
    mock.bridge.promptPlugins = vi.fn(async () => ({
      ok: true as const,
      snapshot: plugins,
    }));
    mock.bridge.submitText = vi.fn(
      () => new Promise<{ turnId: string }>(() => {}),
    );
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    fireEvent.change(draft(), { target: { value: "first request" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(mock.bridge.submitText).toHaveBeenCalled());
    fireEvent.change(draft(), { target: { value: "/" } });
    const menu = screen.getByRole("listbox", { name: "指令" });
    const row = (title: string) =>
      within(menu)
        .getAllByRole("option")
        .find(
          (o) => o.querySelector(".herta-slash-title")?.textContent === title,
        )!;
    expect(await within(menu).findByText("检查")).toBeInTheDocument();
    expect(row("附加文件")).toHaveTextContent("黑塔正在回复，结束后可用");
    expect(row("检查")).toHaveTextContent("黑塔正在回复，结束后可用");
    // The workbench's model choice stays open to changes during a turn.
    expect(row("选择模型")).not.toHaveAttribute("aria-disabled");
    fireEvent.change(draft(), { target: { value: "/检查" } });
    fireEvent.keyDown(draft(), { key: "Enter" });
    expect(
      within(screen.getByRole("listbox", { name: "指令" })).getByRole("alert"),
    ).toHaveTextContent("无法执行“检查”：黑塔正在回复，结束后可用");
    expect(draft()).toHaveValue("/检查");
    expect(screen.queryByRole("region", { name: "快捷操作" })).toBeNull();
  });
  const exportSource = {
    sessionId: "real-session-id",
    title: "导出的任务",
    lang: "zh" as const,
    record: [{ kind: "user" as const, text: "hi" }],
  };
  it("exports the open task from / and from 快捷操作 with the sidebar's export, and says so beside the composer (R124)", async () => {
    const mock = createMockHertaBridge({ sessionActions: { exportSource } });
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    const row = (title: string) =>
      within(screen.getByRole("listbox", { name: "指令" }))
        .getAllByRole("option")
        .find(
          (o) => o.querySelector(".herta-slash-title")?.textContent === title,
        )!;
    // Nothing to export before the first message.
    fireEvent.change(draft(), { target: { value: "/export" } });
    expect(row("导出")).toHaveTextContent("这个任务还没有消息");
    fireEvent.keyDown(draft(), { key: "Enter" });
    expect(mock.calls.readSessionForExport).toEqual([]);
    fireEvent.keyDown(draft(), { key: "Escape" });
    act(() =>
      mock.emitReset({ ...snapshot(), record: [{ kind: "user", text: "hi" }] }),
    );
    fireEvent.change(draft(), { target: { value: "/daochu" } });
    expect(row("导出")).toHaveTextContent("不含附件内容，疑似密钥会遮蔽");
    fireEvent.keyDown(draft(), { key: "Enter" });
    expect(await screen.findByText("已导出")).toHaveAttribute("role", "status");
    expect(mock.calls.readSessionForExport).toEqual(["real-session-id"]);
    expect(mock.calls.saveSessionExport).toHaveLength(1);
    expect(mock.calls.saveSessionExport[0]?.[0]).toBe("导出的任务");
    expect(mock.calls.saveSessionExport[0]?.[1]).toContain("# 导出的任务");
    expect(draft()).toHaveValue("");
    // The same command in 快捷操作, beside the composer's actions.
    fireEvent.click(screen.getByRole("button", { name: "快捷操作" }));
    const common = await screen.findByRole("group", { name: "常用" });
    expect(
      within(common)
        .getAllByRole("button")
        .map((b) => b.firstChild?.textContent),
    ).toEqual(["附加文件", "选择模型", "权限档位", "导出", "反馈"]);
    fireEvent.click(within(common).getByRole("button", { name: /导出/ }));
    await waitFor(() => expect(mock.calls.saveSessionExport).toHaveLength(2));
    expect(mock.calls.readSessionForExport).toEqual([
      "real-session-id",
      "real-session-id",
    ]);
    expect(mock.calls.submitText).toEqual([]);
  });
  it("says an export that could not finish did not touch the record (R124)", async () => {
    const mock = createMockHertaBridge({
      sessionActions: { exportSource: null },
    });
    render(<App bridge={mock.bridge} />);
    act(() =>
      mock.emitReset({ ...snapshot(), record: [{ kind: "user", text: "hi" }] }),
    );
    fireEvent.change(draft(), { target: { value: "/export" } });
    fireEvent.keyDown(draft(), { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法执行“导出”：导出没有完成，原记录未改动",
    );
    expect(mock.calls.readSessionForExport).toEqual(["real-session-id"]);
    expect(mock.calls.saveSessionExport).toEqual([]);
  });
  it("lists no export where the bridge cannot export (R124)", () => {
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    act(() =>
      mock.emitReset({ ...snapshot(), record: [{ kind: "user", text: "hi" }] }),
    );
    fireEvent.change(draft(), { target: { value: "/" } });
    const menu = screen.getByRole("listbox", { name: "指令" });
    expect(within(menu).getByText("权限档位")).toBeInTheDocument();
    expect(within(menu).queryByText("导出")).toBeNull();
  });
  it("opens one feedback panel from / without a task and from 快捷操作, offering the error card's words by choice (R125)", async () => {
    const dialogs = HTMLDialogElement.prototype as unknown as Record<
      string,
      unknown
    >;
    dialogs.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    dialogs.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
    try {
      const mock = createMockHertaBridge({ sessionActions: {} });
      mock.bridge.getWorkbenchPermission = vi.fn(async () => ({
        mode: "workspace-edit" as const,
        revision: 1,
        sessionId: "real-session-id",
        projectId: null,
        source: "session" as const,
        projectMode: "read-only" as const,
      }));
      mock.bridge.getProviderReadiness = vi.fn(
        async (): Promise<ProviderReadiness> => ({
          ready: true,
          sessionId: "real-session-id",
          scope: "session",
          bindings: {
            persona: {
              providerId: "p",
              modelId: "deepseek-chat",
              reasoningEffort: "high",
            },
            executor: { providerId: "p", modelId: "deepseek-coder" },
          },
        }),
      );
      render(<App bridge={mock.bridge} />);
      // Feedback needs no task.
      draft().focus();
      fireEvent.change(draft(), { target: { value: "/feedback" } });
      fireEvent.keyDown(draft(), { key: "Enter" });
      const panel = await screen.findByRole("dialog", { name: "反馈" });
      expect(
        within(panel).getByRole("textbox", { name: /问题描述/ }),
      ).toHaveFocus();
      expect(draft()).toHaveValue("");
      expect(
        await within(panel).findByText("应用版本：0.1.0"),
      ).toBeInTheDocument();
      expect(
        within(panel).getByRole("checkbox", { name: "错误提示" }),
      ).toBeDisabled();
      fireEvent.click(within(panel).getByRole("button", { name: "关闭反馈" }));
      expect(draft()).toHaveFocus();
      // A task whose turn failed: its error card's words are offered, unchecked.
      act(() => mock.emitReset(snapshot()));
      mock.bridge.submitText = vi.fn(async () => ({
        failure: {
          code: "service-unavailable" as const,
          stage: "configuration" as const,
          action: "retry" as const,
          message: "not ready",
        },
      }));
      fireEvent.change(draft(), { target: { value: "hello" } });
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
      expect(await screen.findByText("not ready")).toBeInTheDocument();
      const quick = screen.getByRole("button", { name: "快捷操作" });
      fireEvent.click(quick);
      const common = await screen.findByRole("group", { name: "常用" });
      fireEvent.click(within(common).getByRole("button", { name: /反馈/ }));
      expect(await screen.findByRole("dialog", { name: "反馈" })).toBe(panel);
      const error = within(panel).getByRole("checkbox", { name: "错误提示" });
      expect(error).not.toBeChecked();
      expect(error).toHaveAccessibleDescription("not ready");
      expect(
        within(panel).getByRole("checkbox", { name: "最近一次失败" }),
      ).toHaveAccessibleDescription(
        /^代码：service-unavailable\s+阶段：configuration$/,
      );
      expect(
        within(panel).getByRole("checkbox", { name: "设置概要" }),
      ).toHaveAccessibleDescription(
        /^权限档位：工作区编辑\s+黑塔模型：deepseek-chat · 深度\s+执行模型：deepseek-coder$/,
      );
      fireEvent.click(within(panel).getByRole("button", { name: "关闭反馈" }));
      expect(quick).toHaveFocus();
      expect(mock.calls.saveSessionExport).toEqual([]);
      expect(mock.bridge.submitText).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
      Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    }
  });
  it("lists no feedback where the bridge cannot save (R125)", () => {
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    fireEvent.change(draft(), { target: { value: "/" } });
    const menu = screen.getByRole("listbox", { name: "指令" });
    expect(within(menu).getByText("选择模型")).toBeInTheDocument();
    expect(within(menu).queryByText("反馈")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "反馈" })).toBeNull();
  });
});

describe("R89 attachment preflight", () => {
  it.each(["needsKey", "failure"])("keeps the image card and draft after configuration refusal: %s", async (kind) => {
    const mock = createMockHertaBridge({ pickAttachmentsResult: ["C:\\test\\shot.png"] });
    mock.bridge.submitText = vi.fn(async () => kind === "needsKey" ? { needsKey: true as const } : { failure: { code: "service-unavailable" as const, stage: "configuration" as const, action: "retry" as const, message: "not ready" } });
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    await screen.findByRole("button", { name: "移除 shot.png" });
    fireEvent.change(screen.getByLabelText("任务草稿 · 保存在本机"), { target: { value: "image draft" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(mock.bridge.submitText).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "移除 shot.png" })).toBeInTheDocument();
    expect(screen.getByLabelText("任务草稿 · 保存在本机")).toHaveValue("image draft");
    expect(mock.calls.unstageImage).toEqual([]);
    mock.bridge.submitText = vi.fn(async () => ({ turnId: "retry" }));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(mock.bridge.submitText).toHaveBeenCalledWith("image draft", ["staged-0"], "real-session-id"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "移除 shot.png" })).toBeNull());
  });
});



it("R89 locks attachment removal while submission is pending", async () => {
  const mock = createMockHertaBridge({ pickAttachmentsResult: ["C:\\test\\shot.png"] });
  let finish!: (value: { turnId: string }) => void;
  mock.bridge.submitText = vi.fn(() => new Promise<{ turnId: string }>(resolve => { finish = resolve; }));
  render(<App bridge={mock.bridge} />);
  act(() => mock.emitReset(snapshot()));
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  await screen.findByRole("button", { name: "移除 shot.png" });
  fireEvent.change(screen.getByLabelText("任务草稿 · 保存在本机"), { target: { value: "draft" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(mock.bridge.submitText).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "移除 shot.png" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "移除 shot.png" }));
  expect(mock.calls.unstageImage).toEqual([]);
  await act(async () => finish({ turnId: "t" }));
});

it.each([false, true])("R90 stops a stale submit after switching during attachment import (return=%s)", async (back) => {
  const mock = createMockHertaBridge({ pickAttachmentsResult: ["C:\\test\\spec.md"] });
  let finish!: (value: { ok: true }) => void;
  mock.bridge.attachFiles = vi.fn(() => new Promise<{ ok: true }>(resolve => { finish = resolve; }));
  mock.bridge.submitText = vi.fn(async () => ({ turnId: "wrong-session" }));
  render(<App bridge={mock.bridge} />);
  act(() => mock.emitReset(snapshot()));
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  await screen.findByRole("button", { name: "移除 spec.md" });
  fireEvent.change(screen.getByLabelText("任务草稿 · 保存在本机"), { target: { value: "source draft" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(mock.bridge.attachFiles).toHaveBeenCalled());
  act(() => mock.emitReset(snapshot("other-session")));
  if (back) act(() => mock.emitReset(snapshot()));
  fireEvent.change(screen.getByLabelText("任务草稿 · 保存在本机"), { target: { value: "new draft" } });
  await act(async () => finish({ ok: true }));
  expect(mock.bridge.submitText).not.toHaveBeenCalled();
  expect(screen.getByLabelText("任务草稿 · 保存在本机")).toHaveValue("new draft");
  if (!back) expect(localStorage.getItem("the-herta.draft.session.real-session-id")).toBe("source draft");
});



it("R90 stops submission when switching during the readiness check", async () => {
  const mock = createMockHertaBridge();
  let finish!: (value: ProviderReadiness) => void;
  let gate = false;
  mock.bridge.getProviderReadiness = vi.fn(async () => {
    if (gate) { gate = false; return new Promise<ProviderReadiness>(resolve => { finish = resolve; }); }
    return { ready: true } as ProviderReadiness;
  });
  mock.bridge.submitText = vi.fn(async () => ({ turnId: "t" }));
  render(<App bridge={mock.bridge} />);
  act(() => mock.emitReset(snapshot()));
  await waitFor(() => expect(mock.bridge.getProviderReadiness).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("任务草稿 · 保存在本机"), { target: { value: "original" } });
  gate = true;
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  act(() => mock.emitReset(snapshot("other")));
  await act(async () => finish({ ready: true } as ProviderReadiness));
  expect(mock.bridge.submitText).not.toHaveBeenCalled();
  expect(localStorage.getItem("the-herta.draft.session.real-session-id")).toBe("original");
});

it("R90 retains refused documents and does not import an accepted document twice on retry", async () => {
  const mock = createMockHertaBridge({ pickAttachmentsResult: ["C:\\test\\spec.md"] });
  mock.bridge.attachFiles = vi.fn(async () => ({ ok: false as const, message: "a turn is in progress" }));
  mock.bridge.submitText = vi.fn(async () => ({ needsKey: true as const }));
  render(<App bridge={mock.bridge} />);
  act(() => mock.emitReset(snapshot()));
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  await screen.findByRole("button", { name: "移除 spec.md" });
  fireEvent.change(screen.getByLabelText("任务草稿 · 保存在本机"), { target: { value: "document draft" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(mock.bridge.attachFiles).toHaveBeenCalledTimes(1));
  expect(mock.bridge.submitText).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "移除 spec.md" })).toBeEnabled();
  mock.bridge.attachFiles = vi.fn(async () => ({ ok: true as const }));
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(mock.bridge.submitText).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText("任务草稿 · 保存在本机")).toHaveValue("document draft");
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(mock.bridge.submitText).toHaveBeenCalledTimes(2));
  expect(mock.bridge.attachFiles).toHaveBeenCalledTimes(1);
});

it("R91 restores unsent document cards after remount without importing or sending", async () => {
  localStorage.clear();
  const mock = createMockHertaBridge({ pickAttachmentsResult: ["C:\\test\\pending.md"] });
  const view = render(<App bridge={mock.bridge} />);
  act(() => mock.emitReset(snapshot()));
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  await screen.findByRole("button", { name: "移除 pending.md" });
  view.unmount();
  const next = createMockHertaBridge();
  render(<App bridge={next.bridge} />);
  act(() => next.emitReset(snapshot()));
  expect(await screen.findByRole("button", { name: "移除 pending.md" })).toBeInTheDocument();
  expect(next.calls.attachFiles).toEqual([]);
  expect(next.calls.submitText).toEqual([]);
});


it("R91 preserves and reports a corrupt queue rather than silently clearing it", async () => {
  const key = "the-herta.pending-documents.v1.real-session-id";
  localStorage.setItem(key, "broken");
  const mock = createMockHertaBridge();
  render(<App bridge={mock.bridge} />);
  act(() => mock.emitReset(snapshot()));
  expect(await screen.findByText(/待发附件记录无法读取/)).toBeInTheDocument();
  expect(localStorage.getItem(key)).toBe("broken");
});

it("R91 keeps removal after remount and does not confuse a newly added document", async () => {
  localStorage.setItem("the-herta.pending-documents.v1.real-session-id", JSON.stringify([{ id: "w1", name: "old.md", path: "C:\\test\\old.md" }]));
  const mock = createMockHertaBridge({ pickAttachmentsResult: ["C:\\test\\new.md"] });
  const view = render(<App bridge={mock.bridge} />);
  act(() => mock.emitReset(snapshot()));
  await screen.findByRole("button", { name: "移除 old.md" });
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  await screen.findByRole("button", { name: "移除 new.md" });
  fireEvent.click(screen.getByRole("button", { name: "移除 old.md" }));
  expect(screen.getByRole("button", { name: "移除 new.md" })).toBeInTheDocument();
  view.unmount();
  const next = createMockHertaBridge();
  render(<App bridge={next.bridge} />);
  act(() => next.emitReset(snapshot()));
  await screen.findByRole("button", { name: "移除 new.md" });
  expect(screen.queryByRole("button", { name: "移除 old.md" })).toBeNull();
});

it("R92 discards an old import after switching away and back, preserving newer cards", async () => {
  const mock = createMockHertaBridge({ pickAttachmentsResult: ["C:\\test\\late.png"] });
  const original = mock.bridge.stageImages;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let delayed = true;
  mock.bridge.stageImages = async (...args) => {
    if (delayed) { delayed = false; await gate; }
    return original(...args);
  };
  render(<App bridge={mock.bridge} />);
  act(() => mock.emitReset(snapshot()));
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  await screen.findByRole("button", { name: "取消添加 late.png" });
  act(() => mock.emitReset(snapshot("elsewhere")));
  act(() => mock.emitReset(snapshot()));
  const box = screen.getByLabelText("任务草稿 · 保存在本机").closest(".herta-composer-box") as HTMLElement;
  fireEvent.drop(box, { dataTransfer: { types: ["Files"], files: [{ name: "C:\\test\\new.md" }] } });
  await screen.findByRole("button", { name: "移除 new.md" });
  await act(async () => release());
  // The late result is never adopted as a picture card (R92); since R99 the cut-short
  // read stays visible as a card to retry or remove instead of vanishing.
  expect(screen.queryByRole("button", { name: "查看图片 late.png" })).toBeNull();
  expect(screen.getByRole("button", { name: "重试添加 late.png" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "移除 new.md" })).toBeInTheDocument();
  expect(mock.calls.unstageImage).toHaveLength(1);
});

it("R92 ignores a picker result after leaving and returning to its source task", async () => {
  const mock = createMockHertaBridge();
  let finish!: (paths: string[]) => void;
  mock.bridge.pickAttachments = vi.fn(() => new Promise<string[]>(resolve => { finish = resolve; }));
  mock.bridge.stageImages = vi.fn();
  render(<App bridge={mock.bridge} />);
  act(() => mock.emitReset(snapshot()));
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  act(() => mock.emitReset(snapshot("other")));
  act(() => mock.emitReset(snapshot()));
  await act(async () => finish(["C:\\test\\late.png"]));
  expect(mock.bridge.stageImages).not.toHaveBeenCalled();
});

it.each([false, true])("R92 ignores a stale clipboard read (failure=%s)", async (fail) => {
  const mock = createMockHertaBridge();
  mock.bridge.stageImages = vi.fn();
  let finish!: (bytes: ArrayBuffer) => void;
  let reject!: (error: Error) => void;
  const bytes = new Promise<ArrayBuffer>((resolve, no) => { finish = resolve; reject = no; });
  render(<App bridge={mock.bridge} />);
  act(() => mock.emitReset(snapshot()));
  fireEvent.paste(screen.getByLabelText("任务草稿 · 保存在本机"), {
    clipboardData: { files: [{ type: "image/png", name: "paste.png", arrayBuffer: () => bytes }] },
  });
  act(() => mock.emitReset(snapshot("other")));
  act(() => mock.emitReset(snapshot()));
  await act(async () => { if (fail) reject(new Error("test")); else finish(new ArrayBuffer(1)); });
  expect(mock.bridge.stageImages).not.toHaveBeenCalled();
  expect(screen.queryByText("剪贴板图片未能读取。")).toBeNull();
});

it("R96 shows a manifest recovery issue without dropping the task", async () => {
  const mock = createMockHertaBridge();
  render(<App bridge={mock.bridge} />);
  act(() => mock.emitReset({ ...snapshot(), stagedImageError: "待发图片清单无法读取，原文件已保留。" }));
  expect(await screen.findByText("待发图片清单无法读取，原文件已保留。")).toBeInTheDocument();
  expect(screen.getByLabelText("任务草稿 · 保存在本机")).toBeInTheDocument();
});
it("R96 restores the image card if durable removal fails", async () => {
  const mock = createMockHertaBridge({ pickAttachmentsResult: ["C:\\test\\image.png"] });
  mock.bridge.unstageImage = vi.fn(async () => { throw new Error("disk refused"); });
  render(<App bridge={mock.bridge} />);
  act(() => mock.emitReset(snapshot()));
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  fireEvent.click(await screen.findByRole("button", { name: "移除 image.png" }));
  await screen.findByText("图片未能移除，卡片已保留。请检查存储后重试。");
  expect(screen.getByRole("button", { name: "移除 image.png" })).toBeInTheDocument();
});

describe("R98 pending-picture recovery in the composer", () => {
  const damaged = "待发图片清单无法读取，原文件已保留。";
  it("resets an unreadable manifest only after a confirmation, then clears the notice", async () => {
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset({ ...snapshot(), stagedImageError: damaged }));
    fireEvent.click(await screen.findByRole("button", { name: "重置待发图片清单…" }));
    expect(mock.calls.resetPendingImages).toEqual([]);
    expect(screen.getByText(/不删除任何图片文件/)).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "确认重置清单" });
    await waitFor(() => expect(confirm).toHaveFocus());
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByText(damaged)).toBeNull());
    expect(mock.calls.resetPendingImages).toEqual(["real-session-id"]);
    expect(screen.getByText(/real-session-id\.json\.damaged-test/)).toBeInTheDocument();
  });
  it("cancelling sends nothing and gives focus back to the offer", async () => {
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset({ ...snapshot(), stagedImageError: damaged }));
    fireEvent.click(await screen.findByRole("button", { name: "重置待发图片清单…" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "重置待发图片清单…" })).toHaveFocus());
    expect(mock.calls.resetPendingImages).toEqual([]);
    expect(screen.getByText(damaged)).toBeInTheDocument();
  });
  it("keeps the notice and says so when the reset fails", async () => {
    const mock = createMockHertaBridge({ resetPendingImagesResult: { ok: false, reason: "failed" } });
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset({ ...snapshot(), stagedImageError: damaged }));
    fireEvent.click(await screen.findByRole("button", { name: "重置待发图片清单…" }));
    fireEvent.click(screen.getByRole("button", { name: "确认重置清单" }));
    expect(await screen.findByText("清单未能重置，原文件保留。请检查存储权限后重试。")).toBeInTheDocument();
    expect(screen.getByText(damaged)).toBeInTheDocument();
  });
  it("a reset answered after a task switch leaves the new task's notice alone", async () => {
    const mock = createMockHertaBridge();
    let answer!: (value: { ok: true; backup: string }) => void;
    mock.bridge.resetPendingImages = vi.fn(() => new Promise<{ ok: true; backup: string }>((done) => { answer = done; }));
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset({ ...snapshot(), stagedImageError: damaged }));
    fireEvent.click(await screen.findByRole("button", { name: "重置待发图片清单…" }));
    fireEvent.click(screen.getByRole("button", { name: "确认重置清单" }));
    act(() => mock.emitReset({ ...snapshot("other"), stagedImageError: damaged }));
    await act(async () => answer({ ok: true, backup: "late.json.damaged" }));
    expect(screen.getByText(damaged)).toBeInTheDocument();
    expect(screen.queryByText(/late\.json\.damaged/)).toBeNull();
  });
  it("says the manifest blocks staging instead of blaming the file", async () => {
    const mock = createMockHertaBridge({
      pickAttachmentsResult: ["C:\\test\\next.png"],
      stageImagesResult: { ok: true, staged: [], rejected: [{ name: "next.png", reason: "manifest_unreadable" }] },
    });
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    expect(await screen.findByText("未添加：待发图片清单损坏，暂不能添加图片。请先在上方重置清单。")).toBeInTheDocument();
  });
  it("a removal that works after a refusal takes the refusal with it", async () => {
    const mock = createMockHertaBridge({ pickAttachmentsResult: ["C:\\test\\image.png"] });
    let refuse = true;
    mock.bridge.unstageImage = vi.fn(async () => { if (refuse) throw new Error("disk refused"); return true; });
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "移除 image.png" }));
    await screen.findByText("图片未能移除，卡片已保留。请检查存储后重试。");
    expect(screen.queryByRole("button", { name: "完成配置 / 验证模型" })).toBeNull();
    refuse = false;
    fireEvent.click(screen.getByRole("button", { name: "移除 image.png" }));
    await waitFor(() => expect(screen.queryByText("图片未能移除，卡片已保留。请检查存储后重试。")).toBeNull());
    expect(screen.queryByRole("button", { name: "移除 image.png" })).toBeNull();
  });
  it("a picture that could not be restored points at its card, not the connection", async () => {
    const mock = createMockHertaBridge({ pickAttachmentsResult: ["C:\\test\\gone.png"] });
    const message = "图片没有发给模型：待发图片的本机副本缺失或无法读取。";
    mock.bridge.submitText = vi.fn(async () => ({ failure: { code: "image-unreadable" as const, stage: "configuration" as const, action: "attachment" as const, message } }));
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    await screen.findByRole("button", { name: "移除 gone.png" });
    fireEvent.change(screen.getByLabelText("任务草稿 · 保存在本机"), { target: { value: "with the picture" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "完成配置 / 验证模型" })).toBeNull();
    expect(screen.queryByText(/确认连接后可再次发送/)).toBeNull();
    expect(screen.getByLabelText("任务草稿 · 保存在本机")).toHaveValue("with the picture");
    fireEvent.click(screen.getByRole("button", { name: "移除 gone.png" }));
    await waitFor(() => expect(screen.queryByText(message)).toBeNull());
  });
});

it("R98 a restored picture that cannot be read holds the whole message, its documents included", async () => {
  const mock = createMockHertaBridge({ pickAttachmentsResult: ["C:\\test\\gone.png", "C:\\test\\notes.md"], unreadableStagedImages: ["staged-0"] });
  mock.bridge.submitText = vi.fn(async () => ({ turnId: "t" }));
  render(<App bridge={mock.bridge} />);
  act(() => mock.emitReset(snapshot()));
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  await screen.findByRole("button", { name: "移除 gone.png" });
  await screen.findByRole("button", { name: "移除 notes.md" });
  const draftBox = screen.getByLabelText("任务草稿 · 保存在本机");
  fireEvent.change(draftBox, { target: { value: "both files" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(await screen.findByText(/待发图片的本机副本缺失或无法读取/)).toBeInTheDocument();
  expect(mock.calls.prepareStagedImages).toEqual([["real-session-id", ["staged-0"]]]);
  expect(mock.calls.attachFiles).toEqual([]);
  expect(mock.bridge.submitText).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "移除 notes.md" })).toBeInTheDocument();
  expect(draftBox).toHaveValue("both files");
  expect(screen.queryByRole("button", { name: "完成配置 / 验证模型" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "移除 gone.png" }));
  await waitFor(() => expect(screen.queryByText(/待发图片的本机副本缺失或无法读取/)).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(mock.bridge.submitText).toHaveBeenCalledWith("both files", undefined, "real-session-id"));
  expect(mock.calls.attachFiles).toEqual([["real-session-id", ["C:\\test\\notes.md"]]]);
});

it("R99 gives a document to the message it was sent with, even right after a turn that was cut short", async () => {
  const mock = createMockHertaBridge();
  render(<App bridge={mock.bridge} />);
  const picture = { kind: "attachment" as const, name: "shot.png", path: ".herta/attachments/s/shot.png", lines: 0, chars: 0, image: { format: "png" as const, width: 96, height: 64 } };
  const notes = { kind: "attachment" as const, name: "notes.md", path: ".herta/attachments/s/notes.md", lines: 4, chars: 40 };
  act(() =>
    mock.emitReset({
      ...snapshot(),
      record: [
        { kind: "user", text: "回复被中断的那条" },
        { kind: "system", label: "系统", body: "附件 shot.png", digest: picture },
        { kind: "system", label: "系统", body: "附件 notes.md", digest: notes },
        { kind: "user", text: "带着说明的下一条" },
      ],
    }),
  );
  const first = (await screen.findByText("回复被中断的那条")).closest("article") as HTMLElement;
  const second = screen.getByText("带着说明的下一条").closest("article") as HTMLElement;
  const firstGroup = within(first).getByRole("group", { name: "这条消息的附件" });
  expect(within(firstGroup).getByRole("button", { name: "查看图片 shot.png" })).toBeInTheDocument();
  expect(within(firstGroup).queryByText("notes.md")).toBeNull();
  const secondGroup = within(second).getByRole("group", { name: "这条消息的附件" });
  expect(within(secondGroup).getByText("notes.md")).toBeInTheDocument();
});

describe("R99 cards that never became attachments outlive a restart", () => {
  const issuesKey = "the-herta.pending-attach-issues.v1.real-session-id";
  it("a refused file's card comes back after a restart, with its reason and a retry", async () => {
    const first = createMockHertaBridge({
      pickAttachmentsResult: ["C:\\资料\\keys.png"],
      stageImagesResult: { ok: true, staged: [], rejected: [{ name: "keys.png", reason: "denied" }] },
    });
    const view = render(<App bridge={first.bridge} />);
    act(() => first.emitReset(snapshot()));
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    expect(await screen.findByText("未添加：涉及密钥或凭据，已拒收。")).toBeInTheDocument();
    view.unmount();
    const next = createMockHertaBridge();
    render(<App bridge={next.bridge} />);
    act(() => next.emitReset(snapshot()));
    expect(await screen.findByText("未添加：涉及密钥或凭据，已拒收。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试添加 keys.png" })).toBeInTheDocument();
    expect(next.calls.stageImages).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "移除 keys.png" }));
    await waitFor(() => expect(localStorage.getItem(issuesKey)).toBeNull());
  });
  it("a file still being read when the window closed comes back as a card to retry", async () => {
    const first = createMockHertaBridge({ pickAttachmentsResult: ["C:\\资料\\big.png"] });
    first.bridge.stageImages = vi.fn(() => new Promise<never>(() => {}));
    const view = render(<App bridge={first.bridge} />);
    act(() => first.emitReset(snapshot()));
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    expect(await screen.findByRole("button", { name: "取消添加 big.png" })).toBeInTheDocument();
    view.unmount();
    const next = createMockHertaBridge();
    render(<App bridge={next.bridge} />);
    act(() => next.emitReset(snapshot()));
    expect(await screen.findByText("未添加：上次关闭或切换任务时还没添加完成，请重试或移除。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试添加 big.png" }));
    expect(await screen.findByRole("button", { name: "移除 big.png" })).toBeInTheDocument();
    expect(next.calls.stageImages[0]?.[1]).toEqual([{ path: "C:\\资料\\big.png", name: "big.png" }]);
    await waitFor(() => expect(localStorage.getItem(issuesKey)).toBeNull());
  });
  it("a refused paste comes back asking for a fresh paste, without its bytes or a retry", async () => {
    const first = createMockHertaBridge({ stageImagesResult: { ok: true, staged: [], rejected: [{ name: "pasted-image.png", reason: "too_large" }] } });
    const view = render(<App bridge={first.bridge} />);
    act(() => first.emitReset(snapshot()));
    fireEvent.paste(screen.getByLabelText("任务草稿 · 保存在本机"), {
      clipboardData: { files: [{ type: "image/png", name: "image.png", arrayBuffer: async () => new ArrayBuffer(4) }] },
    });
    expect(await screen.findByText("未添加：图片过大，未添加。")).toBeInTheDocument();
    expect(localStorage.getItem(issuesKey)).not.toMatch(/bytes/);
    view.unmount();
    const next = createMockHertaBridge();
    render(<App bridge={next.bridge} />);
    act(() => next.emitReset(snapshot()));
    expect(await screen.findByText(/粘贴的图片没有保留/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /重试添加/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("任务草稿 · 保存在本机"), { target: { value: "发送前" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("还有附件没有添加成功：请重试或移除它，再发送。")).toBeInTheDocument();
    expect(next.calls.submitText).toEqual([]);
  });
  it("a refused card stays with its task across a switch", async () => {
    const mock = createMockHertaBridge({
      pickAttachmentsResult: ["C:\\资料\\keys.png"],
      stageImagesResult: { ok: true, staged: [], rejected: [{ name: "keys.png", reason: "denied" }] },
    });
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    await screen.findByText("未添加：涉及密钥或凭据，已拒收。");
    act(() => mock.emitReset(snapshot("other")));
    await waitFor(() => expect(screen.queryByText("未添加：涉及密钥或凭据，已拒收。")).toBeNull());
    act(() => mock.emitReset(snapshot()));
    expect(await screen.findByText("未添加：涉及密钥或凭据，已拒收。")).toBeInTheDocument();
  });
  it("keeps an unfinished same-name card when recovery cannot prove its identity (R106)", async () => {
    localStorage.setItem(issuesKey, JSON.stringify([{ id: "w1-x", name: "shot.png", path: "C:\\资料\\shot.png" }, { id: "w2-y", name: "other.png", path: "C:\\资料\\other.png" }]));
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset({ ...snapshot(), stagedImages: [{ id: "i1", name: "shot.png", path: ".herta/attachments/real-session-id/shot.png" }] }));
    expect(await screen.findByRole("button", { name: "查看图片 shot.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试添加 other.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试添加 shot.png" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(issuesKey) ?? "[]")).toEqual([{ id: "w1-x", name: "shot.png", path: "C:\\资料\\shot.png" }, { id: "w2-y", name: "other.png", path: "C:\\资料\\other.png" }]);
  });
});

describe("R100 sending and moving while attachments are in flight", () => {
  it("a queued document gone at send holds the whole message and becomes a card to retry", async () => {
    const mock = createMockHertaBridge({
      pickAttachmentsResult: ["C:\\资料\\spec.md", "C:\\资料\\kept.md"],
      attachFilesResult: { ok: false, message: "missing files", missing: ["C:\\资料\\spec.md"] },
    });
    mock.bridge.submitText = vi.fn(async () => ({ turnId: "t" }));
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot()));
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    await screen.findByRole("button", { name: "移除 spec.md" });
    await screen.findByRole("button", { name: "移除 kept.md" });
    const draftBox = screen.getByLabelText("任务草稿 · 保存在本机");
    fireEvent.change(draftBox, { target: { value: "带两份说明" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText(/发送前发现文件已被移动、删除或无法访问/)).toBeInTheDocument();
    expect(screen.getByText("有附件已不在原位置，这条消息没有发送；文字草稿已保留。")).toBeInTheDocument();
    expect(mock.bridge.submitText).not.toHaveBeenCalled();
    expect(draftBox).toHaveValue("带两份说明");
    expect(screen.getByRole("button", { name: "重试添加 spec.md" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除 kept.md" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "完成配置 / 验证模型" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "移除 spec.md" }));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(mock.calls.attachFiles.at(-1)).toEqual(["real-session-id", ["C:\\资料\\kept.md"]]));
  });
  it("keeps 使用项目新位置 off while a file is still being read", async () => {
    const mock = createMockHertaBridge({ pickAttachmentsResult: ["C:\\资料\\slow.png"] });
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const original = mock.bridge.stageImages;
    mock.bridge.stageImages = async (...args) => { await gate; return original(...args); };
    mock.bridge.getProjectNavigation = vi.fn(async () => ({
      schemaVersion: 1 as const,
      revision: 2,
      projects: [{ projectId: "p", path: "C:\\新目录", name: "项目", alias: null, pinned: false, pinOrder: 0, expanded: true, removed: false, permissionMode: "workspace-edit" as const }],
      tasks: [{ sessionId: "moved-task", projectId: "p", pinned: false, pinOrder: 0, recycled: false, permissionMode: null }],
    }));
    render(<App bridge={mock.bridge} />);
    act(() => mock.emitReset(snapshot("moved-task")));
    const move = await screen.findByRole("button", { name: "使用项目新位置" });
    expect(move).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
    await screen.findByRole("button", { name: "取消添加 slow.png" });
    expect(move).toBeDisabled();
    await act(async () => release());
    await screen.findByRole("button", { name: "移除 slow.png" });
    expect(move).toBeEnabled();
    expect(mock.calls.setWorkspace).toEqual([]);
  });
});


it("R106 keeps a different same-name file, blocks silent send, and removes only the chosen issue", async () => {
  const key = "the-herta.pending-attach-issues.v1.real-session-id";
  const issue = { id: "second-import", name: "shot.png", path: "C:\\second\\shot.png" };
  localStorage.setItem(key, JSON.stringify([issue]));
  const mock = createMockHertaBridge();
  mock.bridge.submitText = vi.fn(async () => ({ turnId: "t" }));
  render(<App bridge={mock.bridge} />);
  const restored = { ...snapshot(), stagedImages: [{ id: "first-image", name: "shot.png", path: ".herta/attachments/real-session-id/first.png" }] };
  act(() => mock.emitReset(restored));
  await screen.findByRole("button", { name: "查看图片 shot.png" });
  expect(JSON.parse(localStorage.getItem(key) ?? "[]")).toContainEqual(issue);
  act(() => mock.emitReset(snapshot("other-session")));
  act(() => mock.emitReset(restored));
  const retry = await screen.findByRole("button", { name: "重试添加 shot.png" });
  fireEvent.change(screen.getByLabelText("任务草稿 · 保存在本机"), { target: { value: "both pictures" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByText("还有附件没有添加成功：请重试或移除它，再发送。");
  expect(mock.bridge.submitText).not.toHaveBeenCalled();
  fireEvent.click(within(retry.closest("li")!).getByRole("button", { name: "移除 shot.png" }));
  expect(screen.getByRole("button", { name: "查看图片 shot.png" })).toBeInTheDocument();
  expect(mock.calls.unstageImage).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(mock.bridge.submitText).toHaveBeenCalledWith("both pictures", ["first-image"], "real-session-id"));
});

it("R106 retries a different same-name image without losing either picture", async () => {
  const key = "the-herta.pending-attach-issues.v1.real-session-id";
  localStorage.setItem(key, JSON.stringify([{ id: "second-import", name: "shot.png", path: "C:\\second\\shot.png" }]));
  const mock = createMockHertaBridge();
  mock.bridge.submitText = vi.fn(async () => ({ turnId: "t" }));
  render(<App bridge={mock.bridge} />);
  act(() => mock.emitReset({ ...snapshot(), stagedImages: [{ id: "first-image", name: "shot.png", path: ".herta/attachments/real-session-id/first.png" }] }));
  fireEvent.click(await screen.findByRole("button", { name: "重试添加 shot.png" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "重试添加 shot.png" })).toBeNull());
  expect(screen.getAllByRole("button", { name: "查看图片 shot.png" })).toHaveLength(2);
  expect(localStorage.getItem(key)).toBeNull();
  fireEvent.change(screen.getByLabelText("任务草稿 · 保存在本机"), { target: { value: "two distinct images" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(mock.bridge.submitText).toHaveBeenCalledWith("two distinct images", ["first-image", "staged-0"], "real-session-id"));
});

describe("a sent picture can stop going to the models (F04, R116)", () => {
  const path = (name: string) => `.herta/attachments/real-session-id/${name}`;
  const picture = (
    name: string,
    stopped = false,
  ): SessionSnapshot["record"][number] => ({
    kind: "system",
    label: "系统",
    body: `附件 ${name} · 图片 PNG · 96×64 · ${path(name)}`,
    digest: {
      kind: "attachment",
      name,
      path: path(name),
      lines: 0,
      chars: 0,
      image: { format: "png", width: 96, height: 64 },
      ...(stopped ? { modelUse: "stopped" as const } : {}),
    },
  });
  const round = (pictures: RoundSummary["pictures"]): RoundSummary => ({
    schemaVersion: 1,
    id: "round-pictures",
    sessionId: "real-session-id",
    attemptIds: ["a"],
    recordStart: 0,
    startedAt: "2026-10-30T00:00:00Z",
    endedAt: "2026-10-30T00:01:00Z",
    durationMs: 60000,
    status: "completed",
    files: [],
    activities: [],
    metrics: {
      totalTokens: null,
      cacheHitRate: null,
      outputTokensPerSecond: null,
      contextUsed: null,
      contextWindow: null,
      partial: true,
    },
    limitations: [],
    pictures,
  });
  const trayOf = async (text: string) =>
    within(
      (await screen.findByText(text)).closest("article") as HTMLElement,
    ).getByRole("group", { name: "这条消息的附件" });
  const itemOf = (name: string) =>
    screen
      .getByRole("button", { name: `查看图片 ${name}` })
      .closest("li") as HTMLElement;

  it("stops one picture by its absolute index and stored path, keeps it viewable, and offers it back once the record says so", async () => {
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    const earlier = { kind: "user" as const, text: "更早的消息" };
    const asked = { kind: "user" as const, text: "看到了什么？" };
    // Sent from the composer, a picture is committed just after its message (R99).
    act(() =>
      mock.emitReset({
        ...snapshot(),
        recordStart: 40,
        record: [earlier, asked, picture("shot.png")],
      }),
    );
    const stop = within(await trayOf("看到了什么？")).getByRole("button", {
      name: "不再发给模型：shot.png",
    });
    expect(stop).toHaveAttribute(
      "title",
      expect.stringContaining("预览与文件都保留"),
    );
    // One picture: no button for the whole message.
    expect(screen.queryByRole("button", { name: /^本条图片都/ })).toBeNull();
    act(() => stop.focus());
    fireEvent.click(stop);
    await waitFor(() =>
      expect(mock.calls.setPictureModelUse).toEqual([
        ["real-session-id", [{ index: 42, path: path("shot.png") }], "stop"],
      ]),
    );
    // The session rewrites the row and pushes the whole record back.
    act(() =>
      mock.emitRecord({
        kind: "reset",
        start: 40,
        record: [earlier, asked, picture("shot.png", true)],
      }),
    );
    const back = await screen.findByRole("button", {
      name: "恢复发给模型：shot.png",
    });
    expect(back).toHaveFocus();
    const item = itemOf("shot.png");
    expect(item).toHaveClass("is-stopped");
    expect(within(item).getByText("不再发给模型")).toBeInTheDocument();
    expect(
      within(item).getByRole("button", { name: "查看图片 shot.png" }),
    ).toBeEnabled();
    fireEvent.click(back);
    await waitFor(() =>
      expect(mock.calls.setPictureModelUse.at(-1)).toEqual([
        "real-session-id",
        [{ index: 42, path: path("shot.png") }],
        "send",
      ]),
    );
  });

  it("says what the newest request did with each picture, matched by index and path, and a stopped picture says so first", async () => {
    const mock = createMockHertaBridge();
    mock.bridge.getRoundSummaries = vi.fn(async () => [
      round({
        persona: [
          { index: 0, path: path("a.png"), outcome: "sent" },
          { index: 1, path: path("b.png"), outcome: "over_limit" },
          { index: 2, path: path("c.png"), outcome: "sent" },
          { index: 3, path: path("older.png"), outcome: "sent" },
          { index: 4, path: path("e.png"), outcome: "unsupported" },
        ],
        executor: [
          { index: 0, path: path("a.png"), outcome: "sent" },
          { index: 1, path: path("b.png"), outcome: "over_limit" },
          { index: 4, path: path("e.png"), outcome: "sent" },
        ],
      }),
    ]);
    render(<App bridge={mock.bridge} />);
    const record = [
      picture("a.png"),
      picture("b.png"),
      picture("c.png", true),
      picture("d.png"),
      picture("e.png"),
    ];
    act(() =>
      mock.emitReset({
        ...snapshot(),
        record: [...record, { kind: "user", text: "五张图" }],
      }),
    );
    await trayOf("五张图");
    await waitFor(() =>
      expect(itemOf("a.png")).toHaveTextContent("已发给黑塔和执行模型"),
    );
    expect(itemOf("b.png")).toHaveTextContent("未发：超出上限");
    expect(itemOf("c.png")).toHaveTextContent("不再发给模型");
    expect(itemOf("c.png")).not.toHaveTextContent("已发给");
    expect(itemOf("e.png")).toHaveTextContent(
      "已发给执行模型；黑塔未收到（未通过识图检测）",
    );
    // The round's row 3 is another file (a rewind since): nothing is said about d.png.
    expect(
      itemOf("d.png").querySelector(".herta-attachment-status"),
    ).toBeNull();
    expect(
      within(itemOf("d.png")).getByRole("button", {
        name: "不再发给模型：d.png",
      }),
    ).toBeInTheDocument();
  });

  it("turns all of a message's pictures off at once, and back on once they all are", async () => {
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    const asked = { kind: "user" as const, text: "两张图" };
    act(() =>
      mock.emitReset({
        ...snapshot(),
        record: [picture("a.png"), picture("b.png", true), asked],
      }),
    );
    fireEvent.click(
      within(await trayOf("两张图")).getByRole("button", {
        name: "本条图片都不再发给模型",
      }),
    );
    // Only the picture not stopped yet is asked for.
    await waitFor(() =>
      expect(mock.calls.setPictureModelUse).toEqual([
        ["real-session-id", [{ index: 0, path: path("a.png") }], "stop"],
      ]),
    );
    act(() =>
      mock.emitRecord({
        kind: "reset",
        start: 0,
        record: [picture("a.png", true), picture("b.png", true), asked],
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "本条图片都恢复发给模型" }),
    );
    await waitFor(() =>
      expect(mock.calls.setPictureModelUse.at(-1)).toEqual([
        "real-session-id",
        [
          { index: 0, path: path("a.png") },
          { index: 1, path: path("b.png") },
        ],
        "send",
      ]),
    );
  });

  it("waits while a turn runs, and says under the tray why a change did not happen", async () => {
    const mock = createMockHertaBridge();
    const answers = [
      { ok: false as const, reason: "not_found" as const },
      { ok: false as const, reason: "turn_in_progress" as const },
    ];
    mock.bridge.setPictureModelUse = vi.fn(async () => {
      const next = answers.shift();
      if (!next) throw new Error("ipc failed");
      return next;
    });
    render(<App bridge={mock.bridge} />);
    act(() =>
      mock.emitReset({
        ...snapshot(),
        record: [picture("shot.png"), { kind: "user", text: "看图" }],
      }),
    );
    const tray = await trayOf("看图");
    const stop = () =>
      within(tray).getByRole("button", { name: "不再发给模型：shot.png" });
    act(() => mock.emitTurn({ kind: "started", turnId: "busy" }));
    expect(stop()).toBeDisabled();
    act(() => mock.emitTurn({ kind: "finished", turnId: "busy" }));
    await waitFor(() => expect(stop()).toBeEnabled());
    fireEvent.click(stop());
    expect(await within(tray).findByRole("alert")).toHaveTextContent(
      "这条消息的图片已经变化，请重试。",
    );
    await waitFor(() => expect(stop()).toBeEnabled());
    fireEvent.click(stop());
    await waitFor(() =>
      expect(within(tray).getByRole("alert")).toHaveTextContent(
        "黑塔正在处理本轮，结束后再更改。",
      ),
    );
    await waitFor(() => expect(stop()).toBeEnabled());
    fireEvent.click(stop());
    await waitFor(() =>
      expect(within(tray).getByRole("alert")).toHaveTextContent(
        "未能更改图片的发送设置，请重试。",
      ),
    );
    expect(mock.bridge.setPictureModelUse).toHaveBeenCalledTimes(3);
  });

  it("drops an answer for a task the window has left", async () => {
    const mock = createMockHertaBridge();
    let answer!: (reply: { ok: false; reason: "not_found" }) => void;
    mock.bridge.setPictureModelUse = vi.fn(
      () =>
        new Promise<{ ok: false; reason: "not_found" }>((done) => {
          answer = done;
        }),
    );
    render(<App bridge={mock.bridge} />);
    act(() =>
      mock.emitReset({
        ...snapshot(),
        record: [picture("shot.png"), { kind: "user", text: "看图" }],
      }),
    );
    const stop = within(await trayOf("看图")).getByRole("button", {
      name: "不再发给模型：shot.png",
    });
    fireEvent.click(stop);
    // While it is pending the switch stays enabled, so a focused switch keeps its focus (Chromium
    // moves focus off a button that becomes disabled), and a second click asks for nothing.
    fireEvent.click(stop);
    expect(stop).toBeEnabled();
    expect(mock.bridge.setPictureModelUse).toHaveBeenCalledTimes(1);
    act(() =>
      mock.emitReset({
        ...snapshot("other-task"),
        record: [picture("shot.png"), { kind: "user", text: "另一个任务" }],
      }),
    );
    const other = await trayOf("另一个任务");
    expect(
      within(other).getByRole("button", { name: "不再发给模型：shot.png" }),
    ).toBeEnabled();
    await act(async () => answer({ ok: false, reason: "not_found" }));
    expect(within(other).queryByRole("alert")).toBeNull();
  });
});

it("R118 names each staging call's card and cancels it in the main process", async () => {
  const mock = createMockHertaBridge({
    pickAttachmentsResult: ["C:\\test\\slow.png"],
  });
  const original = mock.bridge.stageImages;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mock.bridge.stageImages = async (...args) => {
    await gate;
    return original(...args);
  };
  render(<App bridge={mock.bridge} />);
  act(() => mock.emitReset(snapshot()));
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "取消添加 slow.png" }),
  );
  await act(async () => release());
  const job = mock.calls.stageJobs[0];
  expect(job).toMatch(/^w\d+-/);
  expect(mock.calls.cancelStaging).toEqual([["real-session-id", job]]);
  // The mock still stages it, as a main process the cancel reached too late would:
  // the copy is unstaged and never shown.
  expect(mock.calls.unstageImage).toHaveLength(1);
  expect(
    screen.queryByRole("button", { name: "查看图片 slow.png" }),
  ).toBeNull();
});
