import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { resetThemeForTest } from "../../lib/theme.js";
import { WindowSettings } from "./WindowSettings.js";

afterEach(resetThemeForTest);

function setup(platform?: string) {
  const mock = createMockHertaBridge(
    platform !== undefined ? { platform } : {},
  );
  renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <WindowSettings />
    </HertaBridgeProvider>,
  );
  return mock;
}

describe("WindowSettings appearance row (night-mode slice 2)", () => {
  it("renders the Appearance select alongside close-to-tray", () => {
    setup();
    expect(screen.queryByLabelText("Appearance")).toBeNull();
    expect(screen.getByLabelText("Close to tray")).toBeInTheDocument();
  });

  it("on a Mac the row says menu bar, and does not claim that turning it off quits (2026-09-23)", () => {
    setup("darwin");
    expect(screen.getByLabelText("Close to menu bar")).toBeInTheDocument();
    expect(screen.queryByText(/system tray/)).toBeNull();
    expect(screen.getByText(/stays in the Dock until you quit/)).toBeTruthy();
  });

  it("offers persistent light and dark themes while preserving tray persistence", async () => {
    const mock = setup();
    expect(screen.queryByLabelText("Appearance")).toBeNull();
    fireEvent.change(screen.getByLabelText("界面主题"), {target: {value: "light"}});
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(mock.calls.setTheme).toEqual(["light"]);
    fireEvent.click(screen.getByLabelText("Close to tray"));
    expect(mock.calls.setCloseToTray).toHaveLength(1);
  });
});
