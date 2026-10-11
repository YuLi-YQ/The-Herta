import { describe, expect, it } from "vitest";
import atelierOrbit from "../../assets/atelier-orbit.svg";
import { renderWithLocale } from "../../i18n/test-util.js";
import { GalaxyTravelRow } from "./GalaxyTravelRow.js";

describe("GalaxyTravelRow", () => {
  it("shimmers the transfer text (no traveling packet)", () => {
    const { container } = renderWithLocale(<GalaxyTravelRow />);
    expect(container.querySelector(".galaxy-packet")).toBeNull();
    expect(
      container
        .querySelector(".transfer-text")
        ?.classList.contains("is-shimmer"),
    ).toBe(true);
  });

  it("uses one abstract orbit with a decorative empty alt instead of character variants", () => {
    const { container } = renderWithLocale(<GalaxyTravelRow />);
    const icons = container.querySelectorAll("img.transfer-icon");
    expect(icons).toHaveLength(1);
    expect(icons[0]).toHaveClass("atelier-transfer-icon");
    expect(icons[0]).toHaveAttribute("alt", "");
    expect(icons[0]).toHaveAttribute("src", atelierOrbit);
  });
});
