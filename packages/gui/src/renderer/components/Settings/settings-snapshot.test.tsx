import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import type { DeepSeekKeyStatus } from "../../ipc/bridge-types.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { DeepSeekSettings } from "./DeepSeekSettings.js";
import { SettingsModal } from "./SettingsModal.js";
import {
  peekSetting,
  primeSettings,
  rememberSetting,
} from "./settings-snapshot.js";

const CONNECTED: DeepSeekKeyStatus = {
  set: true,
  hint: "30fc",
  encrypted: true,
};

/** Let every already-resolved promise chain run (the mock bridge's reads
 *  are plain async functions). */
const settle = (): Promise<void> => act(async () => {});

describe("settings snapshot — a pane's first frame shows the last-known state (owner 2026-09-18)", () => {
  it("primeSettings reads what the panes read and keeps it per bridge", async () => {
    const a = createMockHertaBridge({
      deepSeekKeyStatus: CONNECTED,
      getDreamConfigResult: { enabled: false },
    });
    const b = createMockHertaBridge();
    expect(peekSetting(a.bridge, "deepseek.keyStatus")).toBeUndefined();
    primeSettings(a.bridge);
    await settle();
    expect(peekSetting(a.bridge, "deepseek.keyStatus")).toEqual(CONNECTED);
    expect(peekSetting(a.bridge, "dream.enabled")).toBeUndefined();
    expect(peekSetting(a.bridge, "voice.engine")).toBeUndefined();
    // Another bridge — another app, or the next test — starts empty.
    expect(peekSetting(b.bridge, "deepseek.keyStatus")).toBeUndefined();
  });

  it("a prime that began before a pane's write does not put the older value back", async () => {
    const mock = createMockHertaBridge({
      closeToTrayResult: true,
    });
    primeSettings(mock.bridge); // in flight, will answer `true`
    rememberSetting(mock.bridge, "window.closeToTray", false); // the user's flip
    await settle();
    expect(peekSetting(mock.bridge, "window.closeToTray")).toBe(false);
  });

  it("DeepSeek pane: a primed status is on the FIRST frame — no 检查中… and the delete link already there", async () => {
    const mock = createMockHertaBridge({ deepSeekKeyStatus: CONNECTED });
    primeSettings(mock.bridge);
    await settle();
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeepSeekSettings />
      </HertaBridgeProvider>,
    );
    // Synchronously after render — before the pane's own read can answer.
    expect(container.querySelector(".settings-key-state")?.textContent).toBe(
      "Connected · …30fc",
    );
    expect(container.querySelector(".settings-key-delete")).not.toBeNull();
    await settle();
  });

  it("DeepSeek pane, nothing read yet: still says it is checking, then lands — the old behavior is the fallback", async () => {
    const mock = createMockHertaBridge({ deepSeekKeyStatus: CONNECTED });
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeepSeekSettings />
      </HertaBridgeProvider>,
    );
    expect(container.querySelector(".settings-key-state")?.textContent).toBe(
      "Checking…",
    );
    await waitFor(() =>
      expect(container.querySelector(".settings-key-state")?.textContent).toBe(
        "Connected · …30fc",
      ),
    );
    // …and what it learned is what the next mount starts from.
    expect(peekSetting(mock.bridge, "deepseek.keyStatus")).toEqual(CONNECTED);
  });

  it("the modal primes supported settings without reading excluded personal features", async () => {
    const mock = createMockHertaBridge();
    const getRealtimeVoice = vi.fn();
    const getDreamConfig = vi.fn();
    const getUpdateState = vi.fn();
    const getAutoUpdate = vi.fn();
    const bridge = {
      ...mock.bridge,
      getRealtimeVoice,
      getDreamConfig,
      getUpdateState,
      getAutoUpdate,
    };
    renderWithLocale(
      <HertaBridgeProvider bridge={bridge}>
        <SettingsModal open={true} onClose={() => {}} />
      </HertaBridgeProvider>,
    );
    await settle();
    expect(peekSetting(bridge, "window.closeToTray")).toBe(true);
    expect(peekSetting(bridge, "banzhuan.thinking")).toBeDefined();
    for (const read of [
      getRealtimeVoice,
      getDreamConfig,
      getUpdateState,
      getAutoUpdate,
    ])
      expect(read).not.toHaveBeenCalled();
    for (const name of ["Voice", "Dream", "Update"])
      expect(screen.queryByRole("button", { name })).toBeNull();
  });
  it("a change made in a pane is what the pane shows on the way back", async () => {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <SettingsModal open={true} onClose={() => {}} />
      </HertaBridgeProvider>,
    );
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "外观" }));
    const toggle = screen.getByLabelText("Close to tray");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "关于" }));
    fireEvent.click(screen.getByRole("button", { name: "外观" }));
    // First frame of the remount — the mock's read would still say `true`
    // only if the write had been lost; the store already says `false`.
    expect(
      screen.getByLabelText("Close to tray").getAttribute("aria-checked"),
    ).toBe("false");
    await settle();
  });
});
