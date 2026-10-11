import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Toggle } from "./Toggle.js";

describe("Toggle", () => {
  it("reflects checked via aria-checked", () => {
    const { getByRole, rerender } = render(
      <Toggle checked={false} onChange={() => {}} ariaLabel="Mute voice" />,
    );
    expect(getByRole("switch").getAttribute("aria-checked")).toBe("false");
    rerender(
      <Toggle checked={true} onChange={() => {}} ariaLabel="Mute voice" />,
    );
    expect(getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("fires onChange with the toggled value on click", () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <Toggle checked={false} onChange={onChange} ariaLabel="Mute voice" />,
    );
    fireEvent.click(getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("exposes its accessible name", () => {
    const { getByLabelText } = render(
      <Toggle checked={false} onChange={() => {}} ariaLabel="Mute voice" />,
    );
    expect(getByLabelText("Mute voice")).toBeTruthy();
  });
});
