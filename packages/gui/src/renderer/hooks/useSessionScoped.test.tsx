import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithSession } from "../testing/renderWithSession.js";
import {
  useOnSessionChange,
  useSessionScoped,
  useSessionScopedRef,
  useSessionScopedTimer,
} from "./useSessionScoped.js";

/**
 * The primitive exists because four ad-hoc reset mechanisms coexisted and
 * several components used none — every "none" was a bug (audit 2026-07-24,
 * Gap 1). These tests pin the contract each of those bugs violated.
 */
describe("useSessionScoped", () => {
  afterEach(() => vi.useRealTimers());

  function Counter(): JSX.Element {
    const [n, setN] = useSessionScoped(0);
    return (
      <button type="button" data-testid="n" onClick={() => setN((v) => v + 1)}>
        {n}
      </button>
    );
  }

  it("keeps state within a session and drops it at the boundary", () => {
    const h = renderWithSession(<Counter />);
    act(() => {
      screen.getByTestId("n").click();
      screen.getByTestId("n").click();
    });
    expect(screen.getByTestId("n").textContent).toBe("2");
    h.switchSession();
    expect(screen.getByTestId("n").textContent).toBe("0");
  });

  it("resets on a delete-blanking too (the pill's boundary)", () => {
    const h = renderWithSession(<Counter />);
    act(() => {
      screen.getByTestId("n").click();
    });
    expect(screen.getByTestId("n").textContent).toBe("1");
    h.deleteSession();
    expect(screen.getByTestId("n").textContent).toBe("0");
  });

  it("does NOT reset on unrelated store churn (a turn's lifecycle)", () => {
    const h = renderWithSession(<Counter />);
    act(() => {
      screen.getByTestId("n").click();
    });
    h.startTurn();
    h.failTurn("provider");
    h.finishTurn();
    expect(screen.getByTestId("n").textContent).toBe("1");
  });
});

describe("useSessionScopedRef", () => {
  it("returns to its initial value at a session boundary", () => {
    const seen: boolean[] = [];
    function Probe(): JSX.Element {
      const ref = useSessionScopedRef(false);
      // A plain local counter so the test can force a re-render WITHIN the
      // same session (the scoped ref itself only re-renders on a session
      // change, by design).
      const [, bump] = useSessionScoped(0);
      seen.push(ref.current);
      ref.current = true;
      return (
        <button
          type="button"
          data-testid="bump"
          onClick={() => bump((v) => v + 1)}
        >
          bump
        </button>
      );
    }
    const h = renderWithSession(<Probe />);
    // Mount reads the initial false, then writes true.
    expect(seen[0]).toBe(false);
    // A re-render inside the SAME session reads the carried-over true.
    act(() => {
      screen.getByTestId("bump").click();
    });
    expect(seen[seen.length - 1]).toBe(true);
    // Crossing the boundary drops it — the stale-edge-baseline bug (M7).
    h.switchSession();
    expect(seen[seen.length - 1]).toBe(false);
  });
});

describe("useSessionScopedTimer", () => {
  afterEach(() => vi.useRealTimers());

  function Delayed({ onFire }: { onFire: () => void }): JSX.Element {
    const timer = useSessionScopedTimer();
    return (
      <button
        type="button"
        data-testid="arm"
        onClick={() => timer.arm(onFire, 1000)}
      >
        arm
      </button>
    );
  }

  it("fires within the session that armed it", () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    renderWithSession(<Delayed onFire={onFire} />);
    act(() => {
      screen.getByTestId("arm").click();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onFire).toHaveBeenCalledOnce();
  });

  it("never fires after a session change (the flash that bled into the next session)", () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const h = renderWithSession(<Delayed onFire={onFire} />);
    act(() => {
      screen.getByTestId("arm").click();
    });
    h.switchSession();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onFire).not.toHaveBeenCalled();
  });

  it("never fires after unmount", () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const h = renderWithSession(<Delayed onFire={onFire} />);
    act(() => {
      screen.getByTestId("arm").click();
    });
    h.unmount();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onFire).not.toHaveBeenCalled();
  });
});

describe("useOnSessionChange", () => {
  it("runs on mount and on every session identity change", () => {
    const fn = vi.fn();
    function Probe(): null {
      useOnSessionChange(fn);
      return null;
    }
    const h = renderWithSession(<Probe />);
    const afterMount = fn.mock.calls.length;
    expect(afterMount).toBeGreaterThanOrEqual(1);
    h.switchSession();
    expect(fn.mock.calls.length).toBe(afterMount + 1);
    h.blank();
    expect(fn.mock.calls.length).toBe(afterMount + 2);
  });
});
