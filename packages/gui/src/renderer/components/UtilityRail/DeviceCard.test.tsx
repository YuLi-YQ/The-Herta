import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { DeviceCard } from "./DeviceCard.js";
import { resetDeviceSceneBackendForTest } from "./device-scene/capability.js";
import { resetDeviceScenePrefForTest } from "./device-scene/device-scene-prefs.js";

// The 3D pref and GPU probe are module-level caches (ADR 0057); every spec
// starts from "unknown" so a seeded bridge in one cannot leak into the next.
afterEach(() => {
  resetDeviceScenePrefForTest();
  resetDeviceSceneBackendForTest();
  // A spec that fails under fake timers must not leave them installed for
  // the `waitFor`-based specs after it (six timeouts from one failure).
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DeviceCard", () => {
  it("shows original geometry and never mounts scene or glow canvases", () => {
    const mock = createMockHertaBridge({ deviceSceneResult: true });
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    expect(container.querySelector("img.atelier-device-mark")).not.toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector("img.device-frost")).toBeNull();
    expect(
      container.querySelector(".device-card")?.getAttribute("data-state"),
    ).toBe("idle");
  });

  it("reflects the device state in the aria-label and data-state", () => {
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    const card = container.querySelector(".device-card");
    expect(card?.getAttribute("aria-label")).toContain("Idle");
    expect(card?.getAttribute("data-state")).toBe("idle");
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: { type: "turn.started", layer: "backend", userText: "" },
      });
    });
    expect(card?.getAttribute("aria-label")).toContain("Working");
    expect(card?.getAttribute("data-state")).toBe("delegated");
  });

  it("shows the effective backend workspace from the reset snapshot", () => {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s-1",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        title: null,
        backendWorkspace: "/home/u/project",
        backendWorkspaceIsDefault: false,
      });
    });
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(
      within(screen.getByRole("menu")).getByText("/home/u/project"),
    ).toBeInTheDocument();
  });

  it("live-updates the displayed workspace from a workspace event", () => {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    act(() => {
      mock.emitWorkspace({
        kind: "workspace",
        workspace: "/live/ws",
        isDefault: false,
      });
    });
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(
      within(screen.getByRole("menu")).getByText("/live/ws"),
    ).toBeInTheDocument();
  });

  it("⋯ menu lists project command rules on open and removes one via the bridge (ADR 0030)", async () => {
    const mock = createMockHertaBridge({
      commandRules: ["node src/index.mjs:*", "dotnet build:*"],
    });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    await waitFor(() =>
      expect(screen.queryByText("node src/index.mjs:*")).toBeTruthy(),
    );
    expect(screen.getByText("Remembered commands")).toBeInTheDocument();
    expect(screen.getByText("dotnet build:*")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove rule node src/index.mjs:*" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("node src/index.mjs:*")).toBeNull(),
    );
    expect(mock.calls.removeCommandRule).toEqual(["node src/index.mjs:*"]);
    expect(screen.getByText("dotnet build:*")).toBeInTheDocument();
  });

  it("⋯ menu re-fetches rules on every open (a rule granted mid-session appears)", async () => {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    const toggle = screen.getByLabelText("device card info");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.queryByText("No commands remembered")).toBeTruthy(),
    );
    expect(mock.calls.listCommandRules).toBe(1);
    fireEvent.click(toggle); // close
    fireEvent.click(toggle); // reopen → fresh fetch
    await waitFor(() => expect(mock.calls.listCommandRules).toBe(2));
  });

  it("an open ⋯ menu closes with its session — a keyboard or tray switch never shows the next session through a stale menu (UX review 2026-09-22, item 11)", async () => {
    const mock = createMockHertaBridge({
      commandRules: ["node src/index.mjs:*"],
    });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    const reset = (sessionId: string): void =>
      act(() => {
        mock.emitReset({
          sessionId,
          workspaceRoot: "/r",
          record: [],
          overlay: null,
          title: null,
          backendWorkspace: `/ws/${sessionId}`,
          backendWorkspaceIsDefault: false,
        });
      });
    reset("s-1");
    fireEvent.click(screen.getByLabelText("device card info"));
    await waitFor(() =>
      expect(screen.queryByText("node src/index.mjs:*")).toBeTruthy(),
    );
    reset("s-2");
    expect(
      screen.getByLabelText("device card info").getAttribute("aria-expanded"),
    ).toBe("false");
    // Reopening fetches the new session's rules.
    fireEvent.click(screen.getByLabelText("device card info"));
    await waitFor(() => expect(mock.calls.listCommandRules).toBe(2));
    expect(
      within(screen.getByRole("menu")).getByText("/ws/s-2"),
    ).toBeInTheDocument();
  });

  it("⋯ menu hides the rules section when the bridge lacks the surface", async () => {
    const mock = createMockHertaBridge();
    const {
      listCommandRules: _a,
      removeCommandRule: _b,
      ...rest
    } = mock.bridge;
    renderWithLocale(
      <HertaBridgeProvider bridge={rest as typeof mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    // The menu renders through a portal at the body (2026-09-17), so the
    // absence is asserted document-wide, not inside the render container.
    expect(document.querySelector(".card-menu-rules")).toBeNull();
    // The workspace half of the menu is untouched by the gate.
    expect(screen.getByRole("button", { name: /Set workspace/ })).toBeTruthy();
  });

  it("opens the picker and sets the chosen workspace", async () => {
    const mock = createMockHertaBridge({ pickWorkspaceResult: "/picked" });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s-1",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        title: null,
        backendWorkspace: "/home/u/project",
        backendWorkspaceIsDefault: false,
      });
    });
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(
      within(screen.getByRole("menu")).getByText("/home/u/project"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Set workspace/ }));
    await waitFor(() => expect(mock.calls.setWorkspace).toHaveLength(1));
    expect(mock.calls.setWorkspace[0]).toEqual(["s-1", "/picked"]);
  });

  it("surfaces a validation error inline when setWorkspace is rejected", async () => {
    const mock = createMockHertaBridge({
      pickWorkspaceResult: "/x",
      setWorkspaceResult: { ok: false, message: "refusing a filesystem root" },
    });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s-1",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        title: null,
        backendWorkspace: "/home/u/project",
        backendWorkspaceIsDefault: false,
      });
    });
    fireEvent.click(screen.getByLabelText("device card info"));
    fireEvent.click(screen.getByRole("button", { name: /Set workspace/ }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/refusing/),
    );
  });

  it("shows no alert on the happy path", async () => {
    const mock = createMockHertaBridge({ pickWorkspaceResult: "/picked" });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s-1",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        title: null,
        backendWorkspace: "/home/u/project",
        backendWorkspaceIsDefault: false,
      });
    });
    fireEvent.click(screen.getByLabelText("device card info"));
    fireEvent.click(screen.getByRole("button", { name: /Set workspace/ }));
    await waitFor(() => expect(mock.calls.setWorkspace).toHaveLength(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not call setWorkspace when the picker is cancelled", async () => {
    const mock = createMockHertaBridge({ pickWorkspaceResult: null });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s-1",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        title: null,
        backendWorkspace: "/home/u/project",
        backendWorkspaceIsDefault: false,
      });
    });
    fireEvent.click(screen.getByLabelText("device card info"));
    fireEvent.click(screen.getByRole("button", { name: /Set workspace/ }));
    await Promise.resolve();
    expect(mock.calls.setWorkspace).toHaveLength(0);
  });

  it("does not open the folder picker for Set workspace when there is no active session", async () => {
    const mock = createMockHertaBridge({ pickWorkspaceResult: "/picked" });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    // Do NOT emit a reset — sessionId stays null
    fireEvent.click(screen.getByLabelText("device card info"));
    fireEvent.click(screen.getByRole("button", { name: /Set workspace/ }));
    await Promise.resolve();
    expect(mock.calls.pickWorkspace).toBe(0);
  });

  it("pointer gestures on the geometry cannot start voice or a lift animation", () => {
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    const mark = container.querySelector(".atelier-device-mark") as HTMLElement;
    fireEvent.mouseDown(mark, { clientY: 100 });
    fireEvent(window, new MouseEvent("mousemove", { clientY: 50 }));
    fireEvent.mouseUp(window);
    expect(mock.calls.maybePlayEasterEgg).toBe(0);
    expect(container.querySelector(".agent-lift-group")).toBeNull();
  });

  it("resets the workspace to default", () => {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s-1",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        title: null,
        backendWorkspace: "/home/u/project",
        backendWorkspaceIsDefault: false,
      });
    });
    fireEvent.click(screen.getByLabelText("device card info"));
    fireEvent.click(screen.getByRole("button", { name: /Reset to default/ }));
    expect(mock.calls.resetWorkspace).toEqual(["s-1"]);
  });

  it("⋯ menu shows workspace trust and toggles it through the bridge (ADR 0064)", async () => {
    const mock = createMockHertaBridge({
      workspaceTrust: {
        effective: "workspace",
        explicit: null,
        isDefaultWorkspace: true,
      },
    });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    await waitFor(() =>
      expect(
        screen.queryByText("Sandbox workspace, trusted by default"),
      ).toBeTruthy(),
    );
    expect(mock.calls.getWorkspaceTrust).toBe(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm each operation instead" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Confirms each operation")).toBeTruthy(),
    );
    expect(mock.calls.setWorkspaceTrust).toEqual(["ask"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Trust this workspace" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText(
          "Trusted: writes, git operations and scripts within it no longer request confirmation",
        ),
      ).toBeTruthy(),
    );
    expect(mock.calls.setWorkspaceTrust).toEqual(["ask", "workspace"]);
  });

  it("⋯ menu hides the trust row when the bridge lacks the surface", async () => {
    const mock = createMockHertaBridge();
    const {
      getWorkspaceTrust: _a,
      setWorkspaceTrust: _b,
      ...rest
    } = mock.bridge;
    renderWithLocale(
      <HertaBridgeProvider bridge={rest as typeof mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    await waitFor(() =>
      expect(screen.queryByText("No commands remembered")).toBeTruthy(),
    );
    expect(document.querySelector(".card-menu-trust")).toBeNull();
  });
});
