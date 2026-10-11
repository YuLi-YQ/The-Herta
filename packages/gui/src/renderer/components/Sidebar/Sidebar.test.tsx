import { act, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { mockSessionList } from "../../mocks/sessions.js";
import { Sidebar } from "./Sidebar.js";

// Fixed reference time matching the mock session dates (deterministic buckets).
const NOW = new Date("2026-05-28T12:00:00Z");

/** Wraps Sidebar with the search state Workbench would own, so tests can
 *  drive the controlled search input and exercise filtering / Escape / focus. */
function ControlledSidebar(props: { initialOpen?: boolean }): JSX.Element {
  const [open, setOpen] = useState(props.initialOpen ?? false);
  const [query, setQuery] = useState("");
  return (
    <Sidebar
      now={NOW}
      searchOpen={open}
      query={query}
      onQueryChange={setQuery}
      onCloseSearch={() => {
        setOpen(false);
        setQuery("");
      }}
    />
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Sidebar", () => {
  it("renders the three recency groups", async () => {
    const mock = createMockHertaBridge({ listSessionsResult: mockSessionList });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <Sidebar now={NOW} />
      </HertaBridgeProvider>,
    );
    await settle();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
    expect(screen.getByText("Previous 7 Days")).toBeInTheDocument();
  });

  it("renders the session list in a scroll wrapper and a pinned Settings button at the foot", async () => {
    const mock = createMockHertaBridge({ listSessionsResult: mockSessionList });
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <Sidebar now={NOW} />
      </HertaBridgeProvider>,
    );
    await settle();
    // The groups live inside the scrolling list wrapper (the search header and
    // Settings footer stay fixed outside it).
    const list = container.querySelector(".sidebar-list");
    expect(list).not.toBeNull();
    expect(list?.querySelector(".session-item")).not.toBeNull();
    // The Settings button is the last child of the column (pinned at the foot).
    const btn = screen.getByRole("button", { name: "Settings" });
    expect(btn.querySelector('svg[data-icon="settings"]')).not.toBeNull();
    const sidebar = container.querySelector(".sidebar");
    const children = Array.from(sidebar?.children ?? []);
    expect(children.indexOf(btn)).toBe(children.length - 1);
  });

  it("wires flip keys on every session card and group label (reorder glide)", async () => {
    const mock = createMockHertaBridge({ listSessionsResult: mockSessionList });
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <Sidebar now={NOW} />
      </HertaBridgeProvider>,
    );
    await settle();
    const keyed = container.querySelectorAll("[data-flip-key]");
    // 8 mock sessions + 3 group labels.
    expect(keyed.length).toBe(mockSessionList.length + 3);
    expect(container.querySelector('[data-flip-key="today-1"]')).not.toBeNull();
    expect(
      container.querySelector('[data-flip-key="label:Today"]'),
    ).not.toBeNull();
  });

  it("marks the active session item with is-active class", async () => {
    const mock = createMockHertaBridge({ listSessionsResult: mockSessionList });
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <Sidebar now={NOW} />
      </HertaBridgeProvider>,
    );
    await settle();
    act(() => {
      mock.emitReset({
        sessionId: "today-1",
        workspaceRoot: "/repo",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    const active = Array.from(
      container.querySelectorAll(".session-item"),
    ).filter((el) => el.classList.contains("is-active"));
    expect(active.length).toBe(1);
  });

  it("keeps the search field mounted but hidden + out of tab order when closed", async () => {
    const mock = createMockHertaBridge({ listSessionsResult: mockSessionList });
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <ControlledSidebar />
      </HertaBridgeProvider>,
    );
    await settle();
    const wrap = container.querySelector(".sidebar-search-wrap");
    expect(wrap).not.toBeNull();
    expect(wrap?.classList.contains("is-open")).toBe(false);
    const input = screen.getByPlaceholderText("Search sessions");
    expect(input).toHaveAttribute("aria-hidden", "true");
    expect(input).toHaveAttribute("tabindex", "-1");
  });

  it("focuses the search field and marks the wrap open when search is open", async () => {
    const mock = createMockHertaBridge({ listSessionsResult: mockSessionList });
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <ControlledSidebar initialOpen />
      </HertaBridgeProvider>,
    );
    await settle();
    const wrap = container.querySelector(".sidebar-search-wrap");
    expect(wrap?.classList.contains("is-open")).toBe(true);
    const input = screen.getByPlaceholderText("Search sessions");
    expect(input).toHaveAttribute("aria-hidden", "false");
    expect(input).toHaveAttribute("tabindex", "0");
    expect(input).toHaveFocus();
  });

  it("filters the session list by title when searching", async () => {
    const mock = createMockHertaBridge({ listSessionsResult: mockSessionList });
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <ControlledSidebar initialOpen />
      </HertaBridgeProvider>,
    );
    await settle();
    fireEvent.change(screen.getByPlaceholderText("Search sessions"), {
      target: { value: "analyze" },
    });
    const items = container.querySelectorAll(".session-item");
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain("Can you analyze");
  });

  it("shows an empty-state line when no session title matches", async () => {
    const mock = createMockHertaBridge({ listSessionsResult: mockSessionList });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <ControlledSidebar initialOpen />
      </HertaBridgeProvider>,
    );
    await settle();
    fireEvent.change(screen.getByPlaceholderText("Search sessions"), {
      target: { value: "zzz-no-match" },
    });
    // The content scan is still pending — the definitive "No matching
    // sessions" waits for it (audit 2026-07-24, 1.13), because `filtered` is
    // title-matches ∪ content-hits and the content half hasn't answered.
    // An indeterminate line shows meanwhile. (The debounced scan RESOLVING is
    // covered by the fake-timer test below.)
    expect(screen.getByText("Searching transcripts…")).toBeInTheDocument();
    expect(screen.queryByText("Today")).not.toBeInTheDocument();
  });

  it("merges transcript content hits into the filter and shows the snippet (debounced)", async () => {
    vi.useFakeTimers();
    const mock = createMockHertaBridge({
      listSessionsResult: mockSessionList,
      searchSessionsResult: [
        {
          sessionId: "yesterday-1",
          snippet: "…the parser cursor never reset…",
          blockIndex: 4,
        },
      ],
    });
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <ControlledSidebar initialOpen />
      </HertaBridgeProvider>,
    );
    await settle();
    fireEvent.change(screen.getByPlaceholderText("Search sessions"), {
      target: { value: "cursor" },
    });
    // No mock TITLE contains "cursor", and the transcript scan hasn't fired
    // yet (debounce) — the list is momentarily empty.
    expect(mock.calls.searchSessions).toEqual([]);
    expect(container.querySelectorAll(".session-item")).toHaveLength(0);
    // The debounce elapses → the scan runs → the content hit merges in,
    // carrying its snippet as the card's preview line.
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mock.calls.searchSessions).toEqual(["cursor"]);
    const items = container.querySelectorAll(".session-item");
    expect(items).toHaveLength(1);
    expect(
      screen.getByText(/the parser cursor never reset/),
    ).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("a previous query's content hits never stand for a new one — not while its scan runs, not after it fails (UX review 2026-09-22, item 20)", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockHertaBridge({
        listSessionsResult: mockSessionList,
      });
      Object.assign(mock.bridge, {
        searchSessions: async (query: string) => {
          if (query === "cursor") {
            return [
              {
                sessionId: "yesterday-1",
                snippet: "…the parser cursor never reset…",
                blockIndex: 4,
              },
            ];
          }
          throw new Error("scan failed");
        },
      });
      const { container } = renderWithLocale(
        <HertaBridgeProvider bridge={mock.bridge}>
          <ControlledSidebar initialOpen />
        </HertaBridgeProvider>,
      );
      await settle();
      const input = screen.getByPlaceholderText("Search sessions");
      const answer = async (): Promise<void> => {
        await act(async () => {
          vi.advanceTimersByTime(200);
          await Promise.resolve();
          await Promise.resolve();
        });
      };
      fireEvent.change(input, { target: { value: "cursor" } });
      await answer();
      expect(container.querySelectorAll(".session-item")).toHaveLength(1);
      // A query the old snippet still contains keeps that hit while its own
      // scan is out — the snippet is real dialogue, so it is a true match.
      fireEvent.change(input, { target: { value: "cursor never" } });
      expect(container.querySelectorAll(".session-item")).toHaveLength(1);
      // A query it does not contain hides it at once, and the failed scan
      // never brings it back.
      fireEvent.change(input, { target: { value: "tokenizer" } });
      expect(container.querySelectorAll(".session-item")).toHaveLength(0);
      await answer();
      expect(container.querySelectorAll(".session-item")).toHaveLength(0);
      expect(
        screen.queryByText(/the parser cursor never reset/),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("content hits clear when the query is emptied", async () => {
    vi.useFakeTimers();
    const mock = createMockHertaBridge({
      listSessionsResult: mockSessionList,
      searchSessionsResult: [
        { sessionId: "yesterday-1", snippet: "…needle…", blockIndex: 2 },
      ],
    });
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <ControlledSidebar initialOpen />
      </HertaBridgeProvider>,
    );
    await settle();
    const input = screen.getByPlaceholderText("Search sessions");
    fireEvent.change(input, { target: { value: "needle" } });
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelectorAll(".session-item")).toHaveLength(1);
    // Clearing the query restores the full list — and drops the stale
    // content hits with it (the snippet preview disappears).
    fireEvent.change(input, { target: { value: "" } });
    expect(container.querySelectorAll(".session-item")).toHaveLength(
      mockSessionList.length,
    );
    expect(screen.queryByText(/needle/)).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("closes the field (wrap loses is-open) and restores the list on Escape", async () => {
    const mock = createMockHertaBridge({ listSessionsResult: mockSessionList });
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <ControlledSidebar initialOpen />
      </HertaBridgeProvider>,
    );
    await settle();
    const input = screen.getByPlaceholderText("Search sessions");
    fireEvent.change(input, { target: { value: "zzz-no-match" } });
    // Either empty-state line proves the list is filtered down; which one
    // depends on whether the content scan has answered yet.
    expect(
      screen.getByText(/No matching sessions|Searching transcripts/),
    ).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    const wrap = container.querySelector(".sidebar-search-wrap");
    expect(wrap?.classList.contains("is-open")).toBe(false);
    expect(input).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(container.querySelectorAll(".session-item").length).toBeGreaterThan(
      0,
    );
  });
});
