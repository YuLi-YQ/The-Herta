import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithLocale } from "../../i18n/test-util.js";
import { PendingActivity } from "./PendingActivity.js";

describe("PendingActivity", () => {
  it("shows 处理中… and a live duration", () => {
    renderWithLocale(
      <PendingActivity
        lang="en"
        turnStartedAt={Date.now() - 2000}
        backendStartedAt={Date.now() - 2000}
      />,
    );
    expect(screen.getByText("Working…")).toBeInTheDocument();
    expect(
      screen
        .getByTestId("pending-activity")
        .querySelector(".activity-line__duration"),
    ).not.toBeNull();
    expect(
      screen
        .getByTestId("pending-activity")
        .querySelector(".activity-line__led.is-pulsing"),
    ).not.toBeNull();
    expect(
      screen
        .getByTestId("pending-activity")
        .querySelector(".activity-line__summary.is-shimmer"),
    ).not.toBeNull();
  });

  it("anchors elapsed duration to backendStartedAt, NOT turnStartedAt, when both are set", () => {
    // turnStartedAt is 80s ago (Herta's turn start, inflated by speech time).
    // backendStartedAt is 3s ago (actual 板砖 dispatch).
    // The displayed duration must be ~3s, NOT ~1:20.
    const turnStartedAt = Date.now() - 80_000;
    const backendStartedAt = Date.now() - 3_000;
    renderWithLocale(
      <PendingActivity
        lang="en"
        turnStartedAt={turnStartedAt}
        backendStartedAt={backendStartedAt}
      />,
    );
    const durationEl = screen
      .getByTestId("pending-activity")
      .querySelector(".activity-line__duration");
    expect(durationEl).not.toBeNull();
    const text = durationEl?.textContent ?? "";
    // Should show something like "3s" — definitely not "1:20" or anything over 10s.
    expect(text).toMatch(/^\d+s$/);
    const seconds = parseInt(text, 10);
    expect(seconds).toBeLessThan(10);
  });

  it("chip + status follow the SESSION lang, not the UI locale", () => {
    // UI locale EN, session zh → Chinese chip + status.
    renderWithLocale(
      <PendingActivity
        lang="zh"
        turnStartedAt={Date.now() - 1000}
        backendStartedAt={Date.now() - 1000}
      />,
    );
    expect(screen.getByText("差分协处理器")).toBeInTheDocument();
    expect(screen.getByText("处理中…")).toBeInTheDocument();
    expect(screen.queryByText("Working…")).toBeNull();
  });
});
