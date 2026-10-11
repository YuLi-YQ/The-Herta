import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../context/HertaBridgeContext.js";
import { renderWithLocale } from "../i18n/test-util.js";
import {
  createMockHertaBridge,
  type MockHertaBridgeOpts,
} from "../ipc/mock-bridge.js";
import { WindowControls } from "./WindowControls.js";

function setup(opts: MockHertaBridgeOpts = {}) {
  const mock = createMockHertaBridge(opts);
  renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <WindowControls />
    </HertaBridgeProvider>,
  );
  return mock;
}

describe("WindowControls", () => {
  it("renders min/max/close with aria-labels and NO title attributes (no hover tooltips)", () => {
    setup();
    for (const name of ["Minimize", "Maximize", "Close"]) {
      const btn = screen.getByRole("button", { name });
      expect(btn).toBeInTheDocument();
      // The whole point: nothing may pop on hover. aria-label is invisible;
      // a title attribute would resurrect the tooltip we just removed.
      expect(btn).not.toHaveAttribute("title");
    }
  });

  it("clicks route to the bridge (close goes through the close-to-tray path in main)", () => {
    const mock = setup();
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(mock.calls.windowMinimize).toBe(1);
    expect(mock.calls.windowToggleMaximize).toBe(1);
    expect(mock.calls.windowClose).toBe(1);
  });

  it("swaps the maximize glyph to Restore on the maximize event and back", () => {
    const mock = setup();
    act(() => mock.emitWindowMaximized(true));
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
    act(() => mock.emitWindowMaximized(false));
    expect(
      screen.getByRole("button", { name: "Maximize" }),
    ).toBeInTheDocument();
  });

  it("seeds the glyph from windowIsMaximized on mount (renderer reload while maximized)", async () => {
    setup({ windowIsMaximizedResult: true });
    expect(
      await screen.findByRole("button", { name: "Restore" }),
    ).toBeInTheDocument();
  });

  it("renders nothing on macOS (native traffic lights remain)", () => {
    setup({ platform: "darwin" });
    expect(screen.queryByRole("button")).toBeNull();
  });
});
