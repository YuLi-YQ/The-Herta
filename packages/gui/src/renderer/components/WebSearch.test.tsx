import { render, screen, fireEvent } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SearchResults, SearchToggle } from "./WebSearch.js";
const openExternal = vi.fn(async () => {});
vi.mock("../context/HertaBridgeContext.js", () => ({
  useHertaBridge: () => ({ bridge: { openExternal } }),
}));
it("opens a returned source only after a click and rejects dangerous URLs", () => {
  render(
    <SearchResults
      events={[
        {
          type: "web-search",
          id: "x",
          status: "completed",
          query: "Python",
          sources: [
            { url: "https://www.python.org", title: "Python official" },
            { url: "javascript:alert(1)", title: "bad" },
          ],
        },
      ]}
    />,
  );
  expect(openExternal).not.toHaveBeenCalled();
  expect(screen.queryByText("bad")).toBeNull();
  fireEvent.click(screen.getByText("Python official"));
  expect(openExternal).toHaveBeenCalledWith("https://www.python.org/");
});
it("does not let unsupported providers appear enabled", () => {
  const onChange = vi.fn();
  render(<SearchToggle supported={false} enabled={true} onChange={onChange} />);
  const button = screen.getByRole("button", { name: "允许联网搜索" });
  expect(button.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(button);
  expect(onChange).not.toHaveBeenCalled();
});
