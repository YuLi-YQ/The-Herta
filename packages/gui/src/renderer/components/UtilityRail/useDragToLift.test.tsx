import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDragToLift } from "./useDragToLift.js";

function Harness(props: {
  readonly onSuccessfulLift?: () => void;
}): JSX.Element {
  const { onMouseDown, transform } = useDragToLift({
    onSuccessfulLift: props.onSuccessfulLift,
    liftProbability: 1, // always lift on chance-pass
    threshold: 5,
    maxLiftPx: 10,
  });
  return (
    <button type="button" data-testid="target" onMouseDown={onMouseDown}>
      <span data-testid="t">{transform ?? ""}</span>
    </button>
  );
}

// matchMedia stub (jsdom doesn't implement it).
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useDragToLift", () => {
  it("applies a transform when dragged upward past threshold (chance always succeeds)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.01);
    const onLift = vi.fn();
    const { getByTestId } = render(<Harness onSuccessfulLift={onLift} />);
    const target = getByTestId("target");

    fireEvent.mouseDown(target, { clientY: 100 });
    act(() => {
      fireEvent(
        window,
        new MouseEvent("mousemove", { clientY: 80 }), // 20px upward
      );
    });
    expect(getByTestId("t").textContent).toMatch(/translateY\(-10px\)/);
    expect(onLift).toHaveBeenCalledTimes(1);
    fireEvent.mouseUp(window);
    vi.restoreAllMocks();
  });

  it("does not apply a transform when reduced motion is preferred", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true, // prefers reduced motion
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const { getByTestId } = render(<Harness />);
    const target = getByTestId("target");
    fireEvent.mouseDown(target, { clientY: 100 });
    expect(getByTestId("t").textContent).toBe("");
  });

  it("removes exactly the window listeners it added across a full drag cycle (no leak)", () => {
    // Regression guard for the stable-handler fix: addEventListener and
    // removeEventListener must use the same function identities so a
    // mousedown→mousemove→mouseup cycle leaves zero residual listeners,
    // even if the component re-renders mid-drag.
    const added: Array<[string, EventListenerOrEventListenerObject]> = [];
    const removed: Array<[string, EventListenerOrEventListenerObject]> = [];
    const realAdd = window.addEventListener.bind(window);
    const realRemove = window.removeEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((type, cb, o) => {
      if (type === "mousemove" || type === "mouseup") {
        added.push([type, cb as EventListenerOrEventListenerObject]);
      }
      return realAdd(type, cb, o);
    });
    vi.spyOn(window, "removeEventListener").mockImplementation(
      (type, cb, o) => {
        if (type === "mousemove" || type === "mouseup") {
          removed.push([type, cb as EventListenerOrEventListenerObject]);
        }
        return realRemove(type, cb, o);
      },
    );

    const { getByTestId, rerender } = render(<Harness />);
    const target = getByTestId("target");

    fireEvent.mouseDown(target, { clientY: 100 });
    // Force a re-render mid-drag — the desync this fix prevents.
    rerender(<Harness onSuccessfulLift={() => undefined} />);
    act(() => {
      fireEvent(window, new MouseEvent("mousemove", { clientY: 90 }));
    });
    fireEvent.mouseUp(window);

    // Every (type, fn) added must have a matching removal.
    expect(removed).toEqual(added);
    expect(added).toHaveLength(2); // one mousemove + one mouseup
    vi.restoreAllMocks();
  });
});
