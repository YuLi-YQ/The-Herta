import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepIcon, stepIcon } from "./step-icon.js";

describe("stepIcon", () => {
  it("maps leading verbs to icon keys", () => {
    expect(stepIcon("Reading scripts")).toBe("read");
    expect(stepIcon("Writing a.ts")).toBe("write");
    expect(stepIcon("Running npm test")).toBe("run");
    expect(stepIcon("Inspecting tree")).toBe("search");
    expect(stepIcon("Saving memory note")).toBe("save");
  });
  it("maps diff/continuation prefixes", () => {
    expect(stepIcon("patch preview: a.ts")).toBe("diff");
    expect(stepIcon("↳ exit 0 · 3 lines")).toBe("result");
  });
  it("falls back to a neutral dot", () => {
    expect(stepIcon("Frobnicating widgets")).toBe("dot");
    expect(stepIcon("")).toBe("dot");
  });
  it("renders an svg tagged with its icon key", () => {
    const { container } = render(<StepIcon kind="read" />);
    expect(container.querySelector('svg[data-icon="read"]')).not.toBeNull();
  });
});
