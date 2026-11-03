import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useResponsiveSidebar } from "./useResponsiveSidebar.js";

const KEY = "the-herta.chat-list-collapsed.v1";

function mockViewport(initialNarrow: boolean) {
  let narrow = initialNarrow;
  const listeners = new Set<() => void>();
  const media = {
    get matches() { return narrow; },
    media: "(max-width: 600px)",
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", (query: string) => {
    expect(query).toBe("(max-width: 600px)");
    return media;
  });
  return {
    change(value: boolean) {
      act(() => { narrow = value; for (const listener of listeners) listener(); });
    },
    listeners,
  };
}

function Harness({ persist = false }: { persist?: boolean }) {
  const [collapsed, setCollapsed] = useResponsiveSidebar(persist ? KEY : undefined);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key === "E")
        setCollapsed(value => !value);
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [setCollapsed]);
  return <>
    <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>导航</button>
    {!collapsed && <aside>列表</aside>}
  </>;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it("starts folded on a narrow window and restores the wide-window choice", () => {
  const viewport = mockViewport(true);
  render(<Harness />);
  expect(screen.queryByText("列表")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "导航" }));
  expect(screen.getByText("列表")).toBeInTheDocument();
  viewport.change(false);
  expect(screen.getByText("列表")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "导航" }));
  expect(screen.queryByText("列表")).toBeNull();
  viewport.change(true);
  fireEvent.click(screen.getByRole("button", { name: "导航" }));
  expect(screen.getByText("列表")).toBeInTheDocument();
  viewport.change(false);
  expect(screen.queryByText("列表")).toBeNull();
});

it.each(["true", "false"])("does not overwrite stored wide preference %s during narrow toggles", (stored) => {
  localStorage.setItem(KEY, stored);
  const write = vi.spyOn(Storage.prototype, "setItem");
  const viewport = mockViewport(true);
  render(<Harness persist />);
  fireEvent.click(screen.getByRole("button", { name: "导航" }));
  fireEvent.click(screen.getByRole("button", { name: "导航" }));
  viewport.change(false);
  expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", String(stored !== "true"));
  expect(write).not.toHaveBeenCalled();
  expect(localStorage.getItem(KEY)).toBe(stored);
  fireEvent.click(screen.getByRole("button", { name: "导航" }));
  expect(localStorage.getItem(KEY)).toBe(String(stored !== "true"));
});

it("uses the keyboard toggle in the current width and folds on each new narrow visit", () => {
  const viewport = mockViewport(false);
  render(<Harness persist />);
  fireEvent.keyDown(window, { key: "E", ctrlKey: true, shiftKey: true });
  expect(localStorage.getItem(KEY)).toBe("true");
  viewport.change(true);
  fireEvent.keyDown(window, { key: "E", ctrlKey: true, shiftKey: true });
  expect(screen.getByText("列表")).toBeInTheDocument();
  expect(localStorage.getItem(KEY)).toBe("true");
  viewport.change(false);
  expect(screen.queryByText("列表")).toBeNull();
  viewport.change(true);
  expect(screen.queryByText("列表")).toBeNull();
});

it("removes the media subscription when the surface unmounts", () => {
  const viewport = mockViewport(false);
  const view = render(<Harness />);
  expect(viewport.listeners.size).toBe(1);
  view.unmount();
  expect(viewport.listeners.size).toBe(0);
});

it("keeps toggles usable when preference storage cannot be read or written", () => {
  mockViewport(false);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw Error("unavailable"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("unavailable"); });
  render(<Harness persist />);
  expect(screen.getByText("列表")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "导航" }));
  expect(screen.queryByText("列表")).toBeNull();
});
