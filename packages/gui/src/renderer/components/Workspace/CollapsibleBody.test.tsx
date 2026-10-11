import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeT } from "../../i18n/LocaleProvider.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { CollapsibleBody } from "./CollapsibleBody.js";
import { ConversationPinProvider } from "./ConversationPin.js";

function longDiff(n: number): string {
  const adds = Array.from({ length: n }, (_, i) => `+line ${i}`);
  return ["patch preview: a.ts", "", "```diff", ...adds, "```"].join("\n");
}

describe("CollapsibleBody", () => {
  it("renders a plain body with no toggle", () => {
    const { container } = renderWithLocale(
      <CollapsibleBody
        body="Reading scripts"
        preClassName="system-body"
        t={makeT("en")}
      />,
    );
    expect(container.querySelector(".diff-disclosure")).toBeNull();
    expect(screen.getByText("Reading scripts")).toBeInTheDocument();
  });

  it("renders a short diff in full with no toggle", () => {
    const { container } = renderWithLocale(
      <CollapsibleBody
        body={longDiff(5)}
        preClassName="system-body"
        t={makeT("en")}
      />,
    );
    expect(container.querySelector(".diff-disclosure")).toBeNull();
  });

  it("collapses a long diff and expands on click", () => {
    const { container } = renderWithLocale(
      <CollapsibleBody
        body={longDiff(30)}
        preClassName="system-body"
        t={makeT("en")}
      />,
    );
    const toggle = container.querySelector(".diff-disclosure");
    expect(toggle).not.toBeNull();
    // Collapsed: header visible, +line 29 not shown.
    expect(screen.getByText(/patch preview/)).toBeInTheDocument();
    expect(screen.queryByText(/\+line 29/)).not.toBeInTheDocument();
    // Expand.
    fireEvent.click(toggle as Element);
    expect(screen.getByText(/\+line 29/)).toBeInTheDocument();
    // Collapse again.
    fireEvent.click(container.querySelector(".diff-disclosure") as Element);
    expect(screen.queryByText(/\+line 29/)).not.toBeInTheDocument();
  });

  it("unpins the conversation on EXPAND only (stale-pin yank, 2026-07-14)", () => {
    // Expanding grows content below the toggle with no scroll event; the
    // conversation must drop its bottom-pin or the next follow trigger
    // scrolls the viewport past the diff ("expands upward").
    const unpin = vi.fn();
    const { container } = renderWithLocale(
      <ConversationPinProvider unpin={unpin}>
        <CollapsibleBody
          body={longDiff(30)}
          preClassName="system-body"
          t={makeT("en")}
        />
      </ConversationPinProvider>,
    );
    const toggle = container.querySelector(".diff-disclosure") as Element;
    fireEvent.click(toggle); // expand
    expect(unpin).toHaveBeenCalledTimes(1);
    fireEvent.click(toggle); // collapse — shrink self-corrects, no unpin
    expect(unpin).toHaveBeenCalledTimes(1);
  });

  it("the toggle labels follow the passed SESSION t, not the UI locale (ADR 0019)", () => {
    // UI locale is "en" (renderWithLocale default); the session-scoped t is
    // zh — the disclosure must speak the session's language.
    const { container } = renderWithLocale(
      <CollapsibleBody
        body={longDiff(30)}
        preClassName="system-body"
        t={makeT("zh")}
      />,
    );
    const toggle = container.querySelector(".diff-disclosure") as Element;
    expect(toggle.textContent).toContain("展开 差异 30 行");
    fireEvent.click(toggle);
    expect(toggle.textContent).toContain("收起");
  });
});
