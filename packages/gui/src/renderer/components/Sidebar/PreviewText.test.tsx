import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PreviewText } from "./PreviewText.js";

describe("PreviewText", () => {
  it("renders the text", () => {
    render(<PreviewText text="hello" />);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("cross-fades to the new text when it changes", async () => {
    const { rerender } = render(<PreviewText text="old message" />);
    expect(screen.getByText("old message")).toBeInTheDocument();

    rerender(<PreviewText text="new message" />);
    // After the fade-out → swap → fade-in, the new text is shown and the old
    // is gone.
    expect(await screen.findByText("new message")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("old message")).not.toBeInTheDocument(),
    );
  });
});
