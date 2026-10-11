import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TitleText } from "./TitleText.js";

describe("TitleText", () => {
  it("renders the text", () => {
    const { getByText } = render(
      <TitleText text="排查解析报错" placeholder="x" animate={false} />,
    );
    expect(getByText("排查解析报错")).toBeInTheDocument();
  });

  it("fires onRevealed immediately when not animating", async () => {
    const onRevealed = vi.fn();
    render(
      <TitleText
        text="Hello"
        placeholder="x"
        animate={false}
        onRevealed={onRevealed}
      />,
    );
    await waitFor(() => expect(onRevealed).toHaveBeenCalledTimes(1));
  });

  it("fires onRevealed only after the reveal completes when animating", async () => {
    const onRevealed = vi.fn();
    render(
      <TitleText
        text="Hi"
        placeholder="x"
        animate={true}
        onRevealed={onRevealed}
      />,
    );
    // Not fired during the fade/type.
    expect(onRevealed).not.toHaveBeenCalled();
    await waitFor(() => expect(onRevealed).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });
  });
});
