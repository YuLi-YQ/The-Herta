import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useResolvedTheme } from "./useResolvedTheme.js";

function Probe(): JSX.Element {
  const theme = useResolvedTheme();
  return <output data-testid="theme">{theme}</output>;
}

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

describe("useResolvedTheme", () => {
  it("reads the stamped theme and defaults to light", async () => {
    render(<Probe />);
    expect(screen.getByTestId("theme").textContent).toBe("light");
    await act(async () => {
      document.documentElement.dataset.theme = "dark";
      // MutationObserver delivers as a microtask.
      await Promise.resolve();
    });
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    await act(async () => {
      document.documentElement.dataset.theme = "light";
      await Promise.resolve();
    });
    expect(screen.getByTestId("theme").textContent).toBe("light");
  });
});
