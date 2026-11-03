import { fireEvent, screen, waitFor } from "@testing-library/react";
import { gsap } from "gsap";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { SettingsModal } from "./SettingsModal.js";

function wrap(open: boolean, close = vi.fn(), initialSection?: "connections") {
  return (
    <HertaBridgeProvider bridge={createMockHertaBridge().bridge}>
      <SettingsModal open={open} onClose={close} {...(initialSection ? { initialSection } : {})} />
    </HertaBridgeProvider>
  );
}
afterEach(() => { localStorage.removeItem("the-herta.motion.v1"); vi.restoreAllMocks(); });

describe("The Herta settings navigation", () => {
  it("is absent when closed", () => {
    renderWithLocale(wrap(false));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("opens focused and exposes only the shipped sections", async () => {
    renderWithLocale(wrap(true));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("The Herta 设置");
    expect(document.activeElement).toBe(dialog);
    for (const name of ["连接与模型", "外观", "插件", "工作区", "快捷键", "关于"])
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    for (const name of ["DeepSeek", "Coprocessor", "Voice", "Dream", "Update"])
      expect(screen.queryByRole("button", { name })).toBeNull();
    await screen.findByText(/还没有连接/);
  });
  it("Escape closes a clean dialog; window controls are not outside clicks", async () => {
    const close = vi.fn();
    renderWithLocale(wrap(true, close));
    await screen.findByText(/还没有连接/);
    const controls = document.createElement("div");
    controls.className = "window-controls";
    document.body.append(controls);
    fireEvent.mouseDown(controls);
    expect(close).not.toHaveBeenCalled();
    controls.remove();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });
  it("an IME's Escape only cancels the candidate (R44)", async () => {
    const close = vi.fn();
    renderWithLocale(wrap(true, close));
    await screen.findByText(/还没有连接/);
    fireEvent.keyDown(document, { key: "Escape", isComposing: true });
    fireEvent.keyDown(document, { key: "Escape", keyCode: 229 });
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });
  it("traps reverse Tab at the modal and forward Tab at the last enabled control", async () => {
    renderWithLocale(wrap(true));
    await screen.findByText(/还没有连接/);
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
  it("generic reopening remembers the last page and explicit connection entries still go there", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const { rerender } = renderWithLocale(wrap(true));
    await screen.findByText(/还没有连接/);
    fireEvent.click(screen.getByRole("button", { name: "关于" }));
    rerender(wrap(false));
    expect(document.activeElement).toBe(trigger);
    rerender(wrap(true));
    await waitFor(() => expect(screen.getByRole("heading", { name: "关于" })).toBeInTheDocument());
    rerender(wrap(false));
    rerender(wrap(true, vi.fn(), "connections"));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "连接与模型" }),
      ).toBeInTheDocument(),
    );
    trigger.remove();
  });
  it("a new entry intention cannot replace an already open settings page", async () => {
    const {rerender}=renderWithLocale(wrap(true));
    await screen.findByText(/还没有连接/);
    fireEvent.click(screen.getByRole("button",{name:"关于"}));
    rerender(wrap(true,vi.fn(),"connections"));
    expect(screen.getByRole("heading",{name:"关于"})).toBeInTheDocument();
  });
});


it.each(["off", "reduced"])("closes without an invisible exit overlay when motion is %s", async (mode) => {
  if (mode === "off") localStorage.setItem("the-herta.motion.v1", "off");
  else vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  const { rerender } = renderWithLocale(wrap(true));
  await screen.findByText(/还没有连接/);
  rerender(wrap(false));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.querySelector(".settings-backdrop")).toBeNull();
  localStorage.removeItem("the-herta.motion.v1");
  vi.restoreAllMocks();
});

it("returns focus to the current settings entry when the original trigger disappears", async () => {
  const original = document.createElement("button");
  const fallback = document.createElement("button");
  fallback.className = "herta-settings-button";
  document.body.append(original, fallback);
  original.focus();
  const { rerender } = renderWithLocale(wrap(true));
  await screen.findByText(/还没有连接/);
  original.remove();
  rerender(wrap(false));
  expect(fallback).toHaveFocus();
  fallback.remove();
});

it("fades the pane in when a section is picked, but not on opening (R73)", async () => {
  document.documentElement.dataset.appearance = "observatory";
  document.documentElement.dataset.motion = "system";
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("no-preference"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  const from = vi.spyOn(gsap, "from");
  try {
    renderWithLocale(wrap(true));
    await screen.findByText(/还没有连接/);
    const pane = document.querySelector(".settings-content");
    expect(from.mock.calls.filter(([target]) => target === pane)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "关于" }));
    await screen.findByText(/HertaAtelier/);
    expect(from.mock.calls.filter(([target]) => target === pane)).toHaveLength(1);
    expect(from.mock.calls.find(([target]) => target === pane)?.[1]).toMatchObject({ opacity: 0 });
  } finally {
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.appearance;
    delete document.documentElement.dataset.motion;
  }
});
