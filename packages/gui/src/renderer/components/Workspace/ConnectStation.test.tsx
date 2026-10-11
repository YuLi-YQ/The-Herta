import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { CONNECT_EXIT_MS, ConnectStation } from "./ConnectStation.js";

function renderIt(show: boolean, mock = createMockHertaBridge()) {
  return {
    mock,
    ...renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <ConnectStation show={show} />
      </HertaBridgeProvider>,
    ),
  };
}

describe("ConnectStation", () => {
  it("renders the 接入黑塔空间站 button when show=true", () => {
    renderIt(true);
    expect(
      screen.getByRole("button", { name: /Connect to Herta/ }),
    ).toBeInTheDocument();
  });

  it("clicking it creates a new session", () => {
    const { mock } = renderIt(true);
    screen.getByRole("button", { name: /Connect to Herta/ }).click();
    expect(mock.calls.createSession).toHaveLength(1);
  });

  it("renders nothing when show=false initially", () => {
    renderIt(false);
    expect(
      screen.queryByRole("button", { name: /Connect to Herta/ }),
    ).not.toBeInTheDocument();
  });

  it("skips the entrance (is-instant) when arriving from a morph", () => {
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <ConnectStation show={true} instant={true} />
      </HertaBridgeProvider>,
    );
    expect(
      container
        .querySelector(".connect-station-wrap")
        ?.classList.contains("is-instant"),
    ).toBe(true);
  });

  it("keeps the entrance (no is-instant) by default", () => {
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <ConnectStation show={true} />
      </HertaBridgeProvider>,
    );
    expect(
      container
        .querySelector(".connect-station-wrap")
        ?.classList.contains("is-instant"),
    ).toBe(false);
  });

  it("on click, calls onConnect with the button rect AND createSession", () => {
    const mock = createMockHertaBridge();
    const onConnect = vi.fn();
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <ConnectStation show={true} onConnect={onConnect} />
      </HertaBridgeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect to Herta" }));
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect.mock.calls[0]?.[0]).toBeTruthy();
    expect(mock.calls.createSession).toHaveLength(1);
  });

  it("calls onConnectFailed when createSession rejects (morph can cancel)", async () => {
    const mock = createMockHertaBridge();
    const failingBridge = {
      ...mock.bridge,
      createSession: () => Promise.reject(new Error("boom")),
    };
    const onConnectFailed = vi.fn();
    renderWithLocale(
      <HertaBridgeProvider bridge={failingBridge}>
        <ConnectStation show={true} onConnectFailed={onConnectFailed} />
      </HertaBridgeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect to Herta" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onConnectFailed).toHaveBeenCalledTimes(1);
  });

  it("calls onConnectFailed when createSession resolves null (no host)", async () => {
    const mock = createMockHertaBridge();
    const nullBridge = {
      ...mock.bridge,
      createSession: () => Promise.resolve(null),
    };
    const onConnectFailed = vi.fn();
    renderWithLocale(
      <HertaBridgeProvider bridge={nullBridge}>
        <ConnectStation show={true} onConnectFailed={onConnectFailed} />
      </HertaBridgeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect to Herta" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onConnectFailed).toHaveBeenCalledTimes(1);
  });

  it("a failed connect's note ends with its attempt — a later, unrelated disconnect shows a clean station (UX review 2026-09-22, item 22)", async () => {
    const mock = createMockHertaBridge();
    const nullBridge = {
      ...mock.bridge,
      createSession: () => Promise.resolve(null),
    };
    const ui = (show: boolean): JSX.Element => (
      <HertaBridgeProvider bridge={nullBridge}>
        <ConnectStation show={show} instantExit={!show} />
      </HertaBridgeProvider>
    );
    const { rerender } = renderWithLocale(ui(true));
    fireEvent.click(screen.getByRole("button", { name: "Connect to Herta" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // A session opens another way (the sidebar) — the station hides…
    rerender(ui(false));
    // …and a later disconnect (the open session deleted) brings it back.
    rerender(ui(true));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("double-click creates only one session (in-flight latch)", () => {
    const { mock } = renderIt(true);
    const btn = screen.getByRole("button", { name: "Connect to Herta" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(mock.calls.createSession).toHaveLength(1);
  });

  it("vanishes instantly (no leave animation) when replaced by the reconnect morph", () => {
    const mock = createMockHertaBridge();
    const { container, rerender } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <ConnectStation show={true} />
      </HertaBridgeProvider>,
    );
    expect(container.querySelector(".connect-station-wrap")).not.toBeNull();
    // Reconnect morph starts: show flips false AND instantExit is set.
    rerender(
      <HertaBridgeProvider bridge={mock.bridge}>
        <ConnectStation show={false} instantExit={true} />
      </HertaBridgeProvider>,
    );
    // Gone this frame — no lingering `is-leaving` connectOut ghost.
    expect(container.querySelector(".connect-station-wrap")).toBeNull();
  });

  it("unmounts after CONNECT_EXIT_MS when show flips false", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockHertaBridge();
      const { rerender } = renderWithLocale(
        <HertaBridgeProvider bridge={mock.bridge}>
          <ConnectStation show={true} />
        </HertaBridgeProvider>,
      );
      expect(
        screen.getByRole("button", { name: /Connect to Herta/ }),
      ).toBeInTheDocument();

      // Flip show=false — the component should stay mounted (playing exit anim)
      // and unmount only after CONNECT_EXIT_MS.
      rerender(
        <HertaBridgeProvider bridge={mock.bridge}>
          <ConnectStation show={false} />
        </HertaBridgeProvider>,
      );
      // Still mounted immediately after the flip (exit animation playing).
      expect(
        screen.getByRole("button", { name: /Connect to Herta/ }),
      ).toBeInTheDocument();

      // Advance past the exit timer.
      act(() => {
        vi.advanceTimersByTime(CONNECT_EXIT_MS + 50);
      });
      expect(
        screen.queryByRole("button", {
          name: /Connect to Herta/,
        }),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
