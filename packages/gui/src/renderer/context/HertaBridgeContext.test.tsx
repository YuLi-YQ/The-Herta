import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createMockHertaBridge } from "../ipc/mock-bridge.js";
import { HertaBridgeProvider, useHertaBridge } from "./HertaBridgeContext.js";

afterEach(() => cleanup());

function Probe(): JSX.Element {
  const { sessionStore, sessionListStore, bridge } = useHertaBridge();
  return (
    <div data-testid="probe">
      {String(
        Boolean(sessionStore) && Boolean(sessionListStore) && Boolean(bridge),
      )}
    </div>
  );
}

describe("HertaBridgeProvider", () => {
  it("provides bridge + constructed stores to descendants", () => {
    const mock = createMockHertaBridge();
    render(
      <HertaBridgeProvider bridge={mock.bridge}>
        <Probe />
      </HertaBridgeProvider>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("true");
  });

  it("useHertaBridge throws outside a provider", () => {
    function Bare(): JSX.Element {
      useHertaBridge();
      return <div />;
    }
    expect(() => render(<Bare />)).toThrow(/HertaBridgeProvider/);
  });

  it("keeps stores live under StrictMode (effect cleanup re-connects IPC)", () => {
    // Regression guard: StrictMode's dev double-invoke runs the provider's
    // effect setup → cleanup → setup. If the store subscribed in its
    // constructor and disposed in the cleanup (the original bug), it was
    // left dead and emitted events never reached the renderer — exactly the
    // "main streams a reply but the UI shows nothing" launch failure.
    const mock = createMockHertaBridge();
    function ShowSession(): JSX.Element {
      const { sessionStore } = useHertaBridge();
      const snap = useSyncExternalStore(
        sessionStore.subscribe,
        sessionStore.getSnapshot,
      );
      return <div data-testid="sid">{snap.sessionId ?? "none"}</div>;
    }
    render(
      <StrictMode>
        <HertaBridgeProvider bridge={mock.bridge}>
          <ShowSession />
        </HertaBridgeProvider>
      </StrictMode>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "live-1",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    expect(screen.getByTestId("sid").textContent).toBe("live-1");
  });
});
