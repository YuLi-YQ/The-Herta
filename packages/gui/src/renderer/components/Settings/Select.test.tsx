import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "../../i18n/test-util.js";
import {
  OVERLAY_Z,
  popOverlay,
  pushOverlay,
  topOverlay,
} from "../../lib/overlay-stack.js";
import { Select } from "./Select.js";

const OPTIONS = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
] as const;

function renderSelect(onChange = vi.fn()): ReturnType<typeof vi.fn> {
  renderWithLocale(
    <Select
      value="zh"
      options={OPTIONS}
      onChange={onChange}
      ariaLabel="Display language"
    />,
  );
  return onChange;
}

describe("Select", () => {
  it("shows the selected label on the trigger; the menu is closed initially", () => {
    renderSelect();
    const trigger = screen.getByLabelText("Display language");
    expect(trigger.textContent).toContain("中文");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens on click, marks the selected option, picks + closes on option click", () => {
    const onChange = renderSelect();
    fireEvent.click(screen.getByLabelText("Display language"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(
      screen
        .getByRole("option", { name: "中文" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "English" }));
    expect(onChange).toHaveBeenCalledWith("en");
    // Presence keeps the menu mounted through its exit; the OPEN class drops
    // immediately (the close is committed).
    expect(document.querySelector(".settings-select-menu.is-open")).toBeNull();
  });

  it("re-picking the current value closes without firing onChange", () => {
    const onChange = renderSelect();
    fireEvent.click(screen.getByLabelText("Display language"));
    fireEvent.click(screen.getByRole("option", { name: "中文" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Escape and outside mousedown close the menu", () => {
    renderSelect();
    const trigger = screen.getByLabelText("Display language");
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("owns the TOPMOST overlay while open, above a settings-level overlay below it", () => {
    // The fix: an open Select registers at cardMenu level (above settings), so
    // a Settings modal below defers its Escape to the dropdown instead of both
    // closing at once (adversarial review 2026-07-15).
    pushOverlay("settings-below", OVERLAY_Z.settings);
    try {
      renderSelect();
      const trigger = screen.getByLabelText("Display language");
      expect(topOverlay()).toBe("settings-below"); // closed: settings is top
      fireEvent.click(trigger); // open
      expect(topOverlay()).not.toBe("settings-below"); // the Select is now top
      fireEvent.keyDown(document, { key: "Escape" }); // close
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(topOverlay()).toBe("settings-below"); // settings regains top
    } finally {
      popOverlay("settings-below");
    }
  });
});
