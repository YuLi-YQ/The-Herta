import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { SettingsModal } from "./SettingsModal.js";

function wrap(open: boolean, close = vi.fn()) {
  return (
    <HertaBridgeProvider bridge={createMockHertaBridge().bridge}>
      <SettingsModal open={open} onClose={close} />
    </HertaBridgeProvider>
  );
}
describe("The Herta settings navigation", () => {
  it("is absent when closed", () => {
    renderWithLocale(wrap(false));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("opens focused and exposes only the five shipped sections", async () => {
    renderWithLocale(wrap(true));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("The Herta 设置");
    expect(document.activeElement).toBe(dialog);
    for (const name of ["连接与模型", "外观", "工作区", "快捷键", "关于"])
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    for (const name of ["DeepSeek", "Coprocessor", "Voice", "Dream", "Update"])
      expect(screen.queryByRole("button", { name })).toBeNull();
    await screen.findByText(/尚无连接/);
  });
  it("Escape closes a clean dialog; window controls are not outside clicks", async () => {
    const close = vi.fn();
    renderWithLocale(wrap(true, close));
    await screen.findByText(/尚无连接/);
    const controls = document.createElement("div");
    controls.className = "window-controls";
    document.body.append(controls);
    fireEvent.mouseDown(controls);
    expect(close).not.toHaveBeenCalled();
    controls.remove();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });
  it("traps reverse Tab at the modal and forward Tab at the last enabled control", async () => {
    renderWithLocale(wrap(true));
    await screen.findByText(/尚无连接/);
    const dialog = screen.getByRole("dialog");
    const buttons = [
      ...dialog.querySelectorAll<HTMLButtonElement>("button"),
    ].filter((b) => !b.disabled);
    const last = buttons.at(-1)!;
    dialog.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(buttons[0]);
  });
  it("reopening starts on connections and restores previous focus on close", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const { rerender } = renderWithLocale(wrap(true));
    await screen.findByText(/尚无连接/);
    fireEvent.click(screen.getByRole("button", { name: "关于" }));
    rerender(wrap(false));
    expect(document.activeElement).toBe(trigger);
    rerender(wrap(true));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "连接与模型" }),
      ).toBeInTheDocument(),
    );
    trigger.remove();
  });
});
