import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderReadiness } from "../../shared/provider-settings-ipc.js";
import { App } from "../App.js";
import type { SessionSnapshot } from "../ipc/bridge-types.js";
import { createMockHertaBridge } from "../ipc/mock-bridge.js";

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
        "必须保留的任务",
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
    fireEvent.click(screen.getByText("···"));
    fireEvent.click(screen.getByRole("button", { name: "重命名 旧任务" }));
    fireEvent.change(screen.getByLabelText("任务名称"), {
      target: { value: "新名称" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await waitFor(() =>
      expect(mock.calls.renameSession).toEqual([["history-id", "新名称"]]),
    );
    fireEvent.click(screen.getByRole("button", { name: "设置 · 连接与模型" }));
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: "当前会话覆盖" }),
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
    expect(screen.getByRole("status")).toHaveTextContent("不自动重放");
    fireEvent.click(screen.getByRole("button", { name: "明确恢复中断任务" }));
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
