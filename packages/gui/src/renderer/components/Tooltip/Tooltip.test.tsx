import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Tooltip } from "./Tooltip.js";

describe("Tooltip", () => {
  it("renders the trigger and a role=tooltip label", () => {
    render(
      <Tooltip label="Hello">
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    expect(screen.getByRole("button", { name: "Trigger" })).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Hello");
  });

  it("defaults to bottom placement", () => {
    const { container } = render(
      <Tooltip label="X">
        <button type="button">T</button>
      </Tooltip>,
    );
    expect(
      container
        .querySelector(".tooltip-wrap")
        ?.classList.contains("tooltip-bottom"),
    ).toBe(true);
  });

  it("applies top placement when requested", () => {
    const { container } = render(
      <Tooltip label="X" placement="top">
        <button type="button">T</button>
      </Tooltip>,
    );
    expect(
      container
        .querySelector(".tooltip-wrap")
        ?.classList.contains("tooltip-top"),
    ).toBe(true);
  });

  it("defaults to align=center, emitting tooltip-align-center", () => {
    const { container } = render(
      <Tooltip label="X">
        <button type="button">T</button>
      </Tooltip>,
    );
    expect(
      container
        .querySelector(".tooltip-wrap")
        ?.classList.contains("tooltip-align-center"),
    ).toBe(true);
  });

  it("emits tooltip-align-end when align=end", () => {
    const { container } = render(
      <Tooltip label="X" align="end">
        <button type="button">T</button>
      </Tooltip>,
    );
    expect(
      container
        .querySelector(".tooltip-wrap")
        ?.classList.contains("tooltip-align-end"),
    ).toBe(true);
  });

  it("emits tooltip-align-start when align=start", () => {
    const { container } = render(
      <Tooltip label="X" align="start">
        <button type="button">T</button>
      </Tooltip>,
    );
    expect(
      container
        .querySelector(".tooltip-wrap")
        ?.classList.contains("tooltip-align-start"),
    ).toBe(true);
  });

  it("renders a muted second line when sub is given, none otherwise", () => {
    const { container, rerender } = render(
      <Tooltip label="Add documents" sub="Text files">
        <button type="button">T</button>
      </Tooltip>,
    );
    expect(container.querySelector(".tooltip-sub")?.textContent).toBe(
      "Text files",
    );
    rerender(
      <Tooltip label="Add documents">
        <button type="button">T</button>
      </Tooltip>,
    );
    expect(container.querySelector(".tooltip-sub")).toBeNull();
  });

  describe("portal mode", () => {
    it("renders nothing until hovered, then mounts the pill on document.body", () => {
      vi.useFakeTimers();
      const { container } = render(
        <Tooltip label="Remove" portal>
          <button type="button">T</button>
        </Tooltip>,
      );
      // No in-flow pill at all — that is the point: an element that is not
      // inside the clipping container cannot be clipped by it.
      expect(container.querySelector(".tooltip")).toBeNull();
      expect(document.querySelector(".tooltip--portal")).toBeNull();

      const wrap = container.querySelector(".tooltip-wrap") as HTMLElement;
      fireEvent.pointerEnter(wrap);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const pill = document.querySelector(".tooltip--portal");
      expect(pill).not.toBeNull();
      expect(pill?.textContent).toBe("Remove");
      // On <body>, not inside the wrap.
      expect(container.querySelector(".tooltip--portal")).toBeNull();

      fireEvent.pointerLeave(wrap);
      expect(document.querySelector(".tooltip--portal")).toBeNull();
      vi.useRealTimers();
    });

    it("does not appear before the hover delay elapses", () => {
      vi.useFakeTimers();
      const { container } = render(
        <Tooltip label="Remove" portal>
          <button type="button">T</button>
        </Tooltip>,
      );
      fireEvent.pointerEnter(
        container.querySelector(".tooltip-wrap") as HTMLElement,
      );
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(document.querySelector(".tooltip--portal")).toBeNull();
      vi.useRealTimers();
    });

    it("reveals immediately on keyboard focus and closes on blur (a11y parity)", () => {
      const { container } = render(
        <Tooltip label="Remove" portal>
          <button type="button">T</button>
        </Tooltip>,
      );
      const btn = container.querySelector("button") as HTMLElement;
      fireEvent.focus(btn);
      expect(document.querySelector(".tooltip--portal")).not.toBeNull();
      fireEvent.blur(btn);
      expect(document.querySelector(".tooltip--portal")).toBeNull();
    });

    it("closes on scroll — a fixed pill must not float detached", () => {
      const { container } = render(
        <Tooltip label="Remove" portal>
          <button type="button">T</button>
        </Tooltip>,
      );
      fireEvent.focus(container.querySelector("button") as HTMLElement);
      expect(document.querySelector(".tooltip--portal")).not.toBeNull();
      fireEvent.scroll(window);
      expect(document.querySelector(".tooltip--portal")).toBeNull();
    });

    it("pointerdown cancels a pending reveal (click should not leave a pill)", () => {
      vi.useFakeTimers();
      const { container } = render(
        <Tooltip label="Remove" portal>
          <button type="button">T</button>
        </Tooltip>,
      );
      const wrap = container.querySelector(".tooltip-wrap") as HTMLElement;
      fireEvent.pointerEnter(wrap);
      fireEvent.pointerDown(wrap);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(document.querySelector(".tooltip--portal")).toBeNull();
      vi.useRealTimers();
    });
  });

  it("suppresses the tooltip on pointerdown and re-arms it on pointerleave", () => {
    const { container } = render(
      <Tooltip label="X">
        <button type="button">T</button>
      </Tooltip>,
    );
    const wrap = container.querySelector(".tooltip-wrap") as HTMLElement;
    expect(wrap.classList.contains("is-suppressed")).toBe(false);
    // Click (pointerdown) hides it while still hovering…
    fireEvent.pointerDown(wrap);
    expect(wrap.classList.contains("is-suppressed")).toBe(true);
    // …and leaving the control re-arms it for the next hover.
    fireEvent.pointerLeave(wrap);
    expect(wrap.classList.contains("is-suppressed")).toBe(false);
  });
});
