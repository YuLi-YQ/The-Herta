import { describe, expect, it } from "vitest";
import { renderWithLocale } from "../../i18n/test-util.js";
import { RecapCompactRow } from "./RecapCompactRow.js";

describe("RecapCompactRow", () => {
  it("shimmers the recap text with NO transfer icons", () => {
    const { container } = renderWithLocale(<RecapCompactRow />);
    // Reuses the shimmer shell…
    expect(
      container
        .querySelector(".transfer-text")
        ?.classList.contains("is-shimmer"),
    ).toBe(true);
    expect(container.querySelector(".status-core")).not.toBeNull();
    expect(container.querySelector(".transfer-text")?.textContent).toBe(
      "Tidying conversation history…",
    );
    // …but TEXT ONLY — no station/earth icons (per request).
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".transfer-icon")).toBeNull();
  });
});
