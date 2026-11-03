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
it("labels a failed search as an answer without live results and hides the internal code", () => {
  render(
    <SearchResults
      events={[
        {
          type: "web-search",
          id: "f",
          status: "failed",
          query: "价格",
          error: "search-unavailable",
        },
      ]}
    />,
  );
  expect(screen.getByText("搜索失败，本次回答未使用联网结果 · 价格")).toBeTruthy();
  expect(screen.queryByText(/search-unavailable/)).toBeNull();
});
it("shows page reads and only claims no live results when nothing succeeded", () => {
  render(
    <SearchResults
      events={[
        { type: "web-search", id: "s1", status: "failed", query: "旧检索", error: "search-unavailable" },
        { type: "web-search", id: "s2", status: "completed", query: "新检索", sources: [{ url: "https://example.com/a", title: "结果A" }] },
        { type: "web-search", id: "f1", status: "completed", query: "https://example.com/a", kind: "fetch", sources: [{ url: "https://example.com/a", title: "页面A" }] },
        { type: "web-search", id: "f2", status: "failed", query: "https://example.com/b", kind: "fetch", error: "fetch-unavailable" },
      ]}
    />,
  );
  expect(screen.getByText("搜索失败 · 旧检索")).toBeTruthy();
  expect(screen.queryByText(/本次回答未使用联网结果/)).toBeNull();
  expect(screen.getByText("已读取全文 · https://example.com/a")).toBeTruthy();
  expect(screen.getByText("读取网页失败 · https://example.com/b")).toBeTruthy();
  expect(screen.queryByText(/fetch-unavailable/)).toBeNull();
});
it("does not let unsupported providers appear enabled", () => {
  const onChange = vi.fn();
  render(<SearchToggle supported={false} enabled={true} onChange={onChange} />);
  const button = screen.getByRole("button", { name: "允许联网搜索" });
  expect(button.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(button);
  expect(onChange).not.toHaveBeenCalled();
});
