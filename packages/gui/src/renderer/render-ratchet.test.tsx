import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
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

describe("round two session isolation", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });
  it("old runtime events cannot inject records into the disconnected workbench", () => {
    const mock = createMockHertaBridge();
    render(<LegacyShell bridge={mock.bridge} />);
    act(() =>
      mock.emitReset({
        sessionId: "old-session",
        record: [{ kind: "user", text: "OLD PRIVATE HISTORY" }],
        workspaceRoot: "/old",
        backendWorkspace: "/old",
        backendWorkspaceIsDefault: false,
        overlay: null,
      }),
    );
    expect(screen.queryByText("OLD PRIVATE HISTORY")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "发送（未接线）" }),
    ).toBeDisabled();
  });
  it("demonstration navigation preserves the real local draft", () => {
    const mock = createMockHertaBridge();
    render(<LegacyShell bridge={mock.bridge} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "真实草稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: "审批样例" }));
    expect(screen.getByRole("textbox")).toHaveValue("真实草稿");
    fireEvent.click(screen.getByRole("button", { name: "允许本次（演示）" }));
    fireEvent.click(screen.getByRole("button", { name: "返回工作台" }));
    expect(screen.getByRole("textbox")).toHaveValue("真实草稿");
    expect(mock.calls.setWorkspace).toHaveLength(0);
  });
});
