import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { RoundTwoWorkbench } from "./components/RoundTwoWorkbench.js";
import { HertaBridgeProvider } from "./context/HertaBridgeContext.js";
import { LocaleProvider } from "./i18n/LocaleProvider.js";
import type { HertaBridge } from "./ipc/bridge-types.js";

function LegacyShell({ bridge }: { bridge: HertaBridge }): JSX.Element {
  return (
    <LocaleProvider locale="zh" onLocaleChange={() => undefined}>
      <HertaBridgeProvider bridge={bridge}>
        <RoundTwoWorkbench />
      </HertaBridgeProvider>
    </LocaleProvider>
  );
}

import { createMockHertaBridge } from "./ipc/mock-bridge.js";

describe("round two desktop shell", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });
  it("starts empty with explicit unconnected sending and no execution", () => {
    const mock = createMockHertaBridge();
    render(<LegacyShell bridge={mock.bridge} />);
    expect(screen.getByText("The Herta")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "发送（未接线）" }),
    ).toBeDisabled();
    expect(
      screen.queryByText("demo-run-001 / request-001"),
    ).not.toBeInTheDocument();
    expect(mock.calls.pickWorkspace).toBe(0);
  });
  it("persists editable Chinese multiline draft across remounts", () => {
    const mock = createMockHertaBridge();
    const first = render(<LegacyShell bridge={mock.bridge} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "中文草稿\n第二行" },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), {
      key: "Enter",
      isComposing: true,
    });
    expect(localStorage.getItem("the-herta.draft.v1")).toBe("中文草稿\n第二行");
    first.unmount();
    render(<LegacyShell bridge={mock.bridge} />);
    expect(screen.getByRole("textbox")).toHaveValue("中文草稿\n第二行");
  });
  it("opens native folder picker while leaving model execution disconnected", async () => {
    const mock = createMockHertaBridge({
      pickWorkspaceResult: "C:\\项目 空格\\黑塔",
    });
    render(<LegacyShell bridge={mock.bridge} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "打开项目文件夹" })[0]!,
    );
    await waitFor(() =>
      expect(screen.getByTitle("C:\\项目 空格\\黑塔")).toBeInTheDocument(),
    );
    expect(mock.calls.pickWorkspace).toBe(1);
    expect(mock.calls.setWorkspace).toHaveLength(0);
  });
  it("cancelled folder selection leaves empty workspace intact", async () => {
    const mock = createMockHertaBridge({ pickWorkspaceResult: null });
    render(<LegacyShell bridge={mock.bridge} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "打开项目文件夹" })[0]!,
    );
    await waitFor(() => expect(mock.calls.pickWorkspace).toBe(1));
    expect(screen.getByText("尚未选择项目")).toBeInTheDocument();
  });
  it("demonstration approval is explicitly isolated and disables processed requests", () => {
    window.history.replaceState(null, "", "/?demo=approval");
    const mock = createMockHertaBridge();
    render(<LegacyShell bridge={mock.bridge} />);
    expect(
      screen.getByText("界面演示 · 不调用模型，不执行工具，不修改文件"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "拒绝（演示）" }));
    expect(
      screen.getByRole("button", { name: "允许本次（演示）" }),
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("演示：已拒绝");
    fireEvent.click(screen.getByRole("button", { name: "重置样例" }));
    fireEvent.click(screen.getByRole("button", { name: "展示过期" }));
    expect(screen.getByRole("button", { name: "拒绝（演示）" })).toBeDisabled();
  });
  it("read-only diff distinguishes binary, empty and failed content", () => {
    window.history.replaceState(null, "", "/?demo=diff");
    const mock = createMockHertaBridge();
    render(<LegacyShell bridge={mock.bridge} />);
    fireEvent.click(
      screen.getByRole("button", { name: "assets/logo.png · 二进制" }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "二进制内容无法显示文本 diff",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "src/empty.ts · 空文件" }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("该文件为空");
    fireEvent.click(
      screen.getByRole("button", { name: "src/unreadable.ts · 读取失败" }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("演示读取失败");
  });
  it("collapses navigation and adjusts separator by keyboard", () => {
    const mock = createMockHertaBridge();
    const { container } = render(<LegacyShell bridge={mock.bridge} />);
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
    expect(localStorage.getItem("the-herta.sidebar.v1")).toBe("250");
    fireEvent.click(screen.getByRole("button", { name: "收起导航" }));
    expect(container.querySelector(".herta-focused")).toBeInTheDocument();
  });
  it("application settings command opens existing settings dialog", async () => {
    const mock = createMockHertaBridge();
    render(<LegacyShell bridge={mock.bridge} />);
    act(() => mock.emitOpenSettings());
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  });
  it("keeps a diagnosable error screen when preload is absent", () => {
    const previous = window.herta;
    Object.defineProperty(window, "herta", {
      configurable: true,
      value: undefined,
    });
    render(<App />);
    expect(screen.getByTestId("app-error")).toBeInTheDocument();
    Object.defineProperty(window, "herta", {
      configurable: true,
      value: previous,
    });
  });
});
