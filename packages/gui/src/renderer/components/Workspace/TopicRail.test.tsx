import type { SessionTopic } from "@herta/app-server";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "../../i18n/test-util.js";
import {
  RAIL_MAX_TOPICS,
  railWindowStart,
  TopicRail,
  topicIndexAt,
} from "./TopicRail.js";

function topic(i: number): SessionTopic {
  return {
    title: `Topic ${i}`,
    anchorIndex: i * 6,
    anchorText: `question ${i}`,
    at: "t",
  };
}

function widths(container: HTMLElement): number[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(".topic-rail__line"),
  ).map((el) => Number.parseFloat(el.style.width));
}

/** Scrollspy fixture: a fake conversation scroller (viewport 0..600) whose
 *  `[data-abs-index]` rows report the tops in `tops` — mutate the map and
 *  fire a scroll to simulate the user scrolling. jsdom has no layout, so
 *  both rect sources are stubbed. */
function makeScroller(tops: Map<number, number>): HTMLElement {
  const scroller = document.createElement("div");
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600 }) as DOMRect;
  for (const idx of tops.keys()) {
    const row = document.createElement("div");
    row.dataset.absIndex = String(idx);
    row.getBoundingClientRect = () =>
      ({
        top: tops.get(idx) ?? 0,
        bottom: (tops.get(idx) ?? 0) + 40,
      }) as DOMRect;
    scroller.append(row);
  }
  document.body.append(scroller);
  return scroller;
}

function currentLabels(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(".topic-rail__tick.is-current"),
  ).map((el) => el.getAttribute("aria-label") ?? "");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TopicRail", () => {
  it("re-entry twins (same anchor) get distinct row identities (review 2026-07-31)", () => {
    // A re-entry retitle windows back over an earlier exchange, so its fresh
    // topic legitimately shares the old topic's anchorIndex — and that pair
    // is exactly what makes the rail visible in a resumed 1-topic session.
    // Keyed on the anchor alone, React reported duplicate keys and
    // useFlipList's rect map kept only the second twin.
    const errors = vi.spyOn(console, "error");
    const twins: SessionTopic[] = [
      {
        title: "旧话题",
        anchorIndex: 0,
        anchorText: "hi",
        at: "2026-07-30T00:00:00Z",
        bornAtLength: 2,
      },
      {
        title: "新话题",
        anchorIndex: 0,
        anchorText: "hi",
        at: "2026-07-31T00:00:00Z",
        bornAtLength: 4,
      },
    ];
    const { container } = renderWithLocale(
      <TopicRail topics={twins} lang="zh" onJump={() => undefined} />,
    );
    const flipKeys = Array.from(
      container.querySelectorAll<HTMLElement>(".topic-rail__tick"),
    ).map((el) => el.dataset.flipKey);
    expect(flipKeys).toHaveLength(2);
    expect(new Set(flipKeys).size).toBe(2);
    expect(errors).not.toHaveBeenCalledWith(
      expect.stringContaining("same key"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("renders nothing below two topics (no chrome for short sessions)", () => {
    const { container } = renderWithLocale(
      <TopicRail topics={[topic(0)]} lang="zh" onJump={() => undefined} />,
    );
    expect(container.querySelector(".topic-rail")).toBeNull();
  });

  it("shows one tick per topic, capped at the latest N", () => {
    const many = Array.from({ length: RAIL_MAX_TOPICS + 5 }, (_, i) =>
      topic(i),
    );
    const { container } = renderWithLocale(
      <TopicRail topics={many} lang="zh" onJump={() => undefined} />,
    );
    const ticks = container.querySelectorAll(".topic-rail__tick");
    expect(ticks).toHaveLength(RAIL_MAX_TOPICS);
    // The latest topics survive the cap (oldest dropped).
    expect(screen.queryByLabelText("Topic 0")).toBeNull();
    expect(screen.getByLabelText(`Topic ${RAIL_MAX_TOPICS + 4}`)).toBeTruthy();
  });

  it("hover swells the hovered line most, neighbors less (distance falloff), and leave resets", () => {
    const topics = Array.from({ length: 6 }, (_, i) => topic(i));
    const { container } = renderWithLocale(
      <TopicRail topics={topics} lang="zh" onJump={() => undefined} />,
    );
    // At rest every line sits at the base width.
    const rest = widths(container);
    expect(new Set(rest).size).toBe(1);
    const base = rest[0] ?? 0;
    // Hover tick 2: it grows most; 1 and 3 grow equally but less; the swell
    // decays with distance and dies out by the falloff radius.
    fireEvent.mouseEnter(screen.getByLabelText("Topic 2"));
    const w = widths(container);
    expect(w[2]).toBeGreaterThan(w[1] ?? 0);
    expect(w[1]).toBeGreaterThan(w[0] ?? 0);
    expect(w[1]).toBeCloseTo(w[3] ?? 0);
    expect(w[0]).toBeGreaterThan(base);
    expect(w[5]).toBe(base); // distance 3 — beyond the swell
    // Leaving the rail resets every line to base — the CSS transition plays
    // the same move in reverse.
    const rail = container.querySelector(".topic-rail") as HTMLElement;
    fireEvent.mouseLeave(rail);
    expect(widths(container)).toEqual(rest);
  });

  it("the card's top re-stamps once a window glide lands (deferred-fix 2026-07-31)", () => {
    // A hover landing mid-slide measured a rect still carrying the FLIP
    // glide's translateY — the card sat up to one pitch off the tick and
    // nothing corrected it.
    vi.useFakeTimers();
    try {
      const topics = Array.from({ length: 4 }, (_, i) => topic(i));
      const { container } = renderWithLocale(
        <TopicRail topics={topics} lang="zh" onJump={() => undefined} />,
      );
      const tick = screen.getByLabelText("Topic 1") as HTMLElement;
      // Mid-glide: the tick's rect reads 14px above its settled slot.
      let tickTop = 14;
      tick.getBoundingClientRect = () => ({ top: tickTop }) as DOMRect;
      fireEvent.mouseEnter(tick);
      const card = container.querySelector(".topic-rail__card") as HTMLElement;
      expect(card.style.top).toBe("14px");
      // The glide lands; the tick now reads its true position — and the
      // card follows without another hover event.
      tickTop = 28;
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(card.style.top).toBe("28px");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hovering raises the topic card (title + anchoring user message)", () => {
    const topics = [topic(0), topic(1), topic(2)];
    const { container } = renderWithLocale(
      <TopicRail topics={topics} lang="zh" onJump={() => undefined} />,
    );
    expect(container.querySelector(".topic-rail__card")).toBeNull();
    fireEvent.mouseEnter(screen.getByLabelText("Topic 1"));
    expect(screen.getByText("Topic 1")).toBeTruthy();
    expect(screen.getByText("question 1")).toBeTruthy();
  });

  it("the card aliases record text 板砖→Brick in an EN session (zh untouched)", () => {
    const topics: SessionTopic[] = [
      {
        title: "让 板砖 修 parser",
        anchorIndex: 0,
        anchorText: "@板砖 fix it",
        at: "t",
      },
      topic(1),
    ];
    const { container, rerender } = renderWithLocale(
      <TopicRail topics={topics} lang="en" onJump={() => undefined} />,
    );
    fireEvent.mouseEnter(
      container.querySelectorAll(".topic-rail__tick")[0] as Element,
    );
    expect(
      container.querySelector(".topic-rail__card-title")?.textContent,
    ).toBe("让 Brick 修 parser");
    expect(
      container.querySelector(".topic-rail__card-preview")?.textContent,
    ).toBe("@Brick fix it");
    // zh session: the same record text stays byte-identical.
    rerender(<TopicRail topics={topics} lang="zh" onJump={() => undefined} />);
    expect(
      container.querySelector(".topic-rail__card-title")?.textContent,
    ).toBe("让 板砖 修 parser");
    expect(
      container.querySelector(".topic-rail__card-preview")?.textContent,
    ).toBe("@板砖 fix it");
  });

  it("clicking a tick jumps to its anchor index", () => {
    const onJump = vi.fn();
    renderWithLocale(
      <TopicRail topics={[topic(0), topic(1)]} lang="zh" onJump={onJump} />,
    );
    fireEvent.click(screen.getByLabelText("Topic 1"));
    expect(onJump).toHaveBeenCalledWith(6);
  });

  it("no fold at or below the cap", () => {
    const { container } = renderWithLocale(
      <TopicRail
        topics={Array.from({ length: RAIL_MAX_TOPICS }, (_, i) => topic(i))}
        lang="zh"
        onJump={() => undefined}
      />,
    );
    expect(container.querySelector(".topic-rail__more")).toBeNull();
  });

  it("scrollspy: inks the tick whose topic region the viewport shows (no hover needed)", () => {
    // Topics anchor at 0/6/12/18. Viewport (0..600): anchor 6 starts above
    // the top, a mid-region user row (9) is visible, anchor 12 starts below
    // the bottom → only topic 1's region [6,12) is in view.
    const tops = new Map<number, number>([
      [0, -500],
      [6, -100],
      [9, 200],
      [12, 700],
      [18, 1300],
    ]);
    const scroller = makeScroller(tops);
    try {
      const topics = [topic(0), topic(1), topic(2), topic(3)];
      const { container } = renderWithLocale(
        <TopicRail
          topics={topics}
          lang="zh"
          onJump={() => undefined}
          scrollerRef={{ current: scroller }}
        />,
      );
      expect(currentLabels(container)).toEqual(["Topic 1"]);
    } finally {
      scroller.remove();
    }
  });

  it("scrollspy: a viewport straddling a topic boundary inks BOTH ticks", () => {
    // Anchor 6 above the top, anchor 12 in view → regions [6,12) and [12,18)
    // both intersect the viewport (the Codex two-lines case).
    const tops = new Map<number, number>([
      [0, -900],
      [6, -100],
      [12, 300],
      [18, 900],
    ]);
    const scroller = makeScroller(tops);
    try {
      const { container } = renderWithLocale(
        <TopicRail
          topics={[topic(0), topic(1), topic(2), topic(3)]}
          lang="zh"
          onJump={() => undefined}
          scrollerRef={{ current: scroller }}
        />,
      );
      expect(currentLabels(container)).toEqual(["Topic 1", "Topic 2"]);
    } finally {
      scroller.remove();
    }
  });

  it("scrollspy: re-measures on scroll (rAF-throttled) — the ink follows the view", () => {
    const rafCbs: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCbs.push(cb);
      return rafCbs.length;
    });
    const tops = new Map<number, number>([
      [0, -500],
      [6, -100],
      [12, 700],
      [18, 1300],
    ]);
    const scroller = makeScroller(tops);
    try {
      const { container } = renderWithLocale(
        <TopicRail
          topics={[topic(0), topic(1), topic(2), topic(3)]}
          lang="zh"
          onJump={() => undefined}
          scrollerRef={{ current: scroller }}
        />,
      );
      expect(currentLabels(container)).toEqual(["Topic 1"]);
      // Scroll down two regions: now only topic 2's region is in view.
      tops.set(0, -1700);
      tops.set(6, -1300);
      tops.set(12, -500);
      tops.set(18, 700);
      fireEvent.scroll(scroller);
      act(() => {
        for (const cb of rafCbs.splice(0)) cb(0);
      });
      expect(currentLabels(container)).toEqual(["Topic 2"]);
    } finally {
      scroller.remove();
    }
  });

  it("scrollspy: finds the span with a handful of rect reads, not one per row", () => {
    // Perf 2026-07-30: this runs once per rAF for the whole life of a scroll,
    // including under the send animations where the user saw frames drop. The
    // linear version read a rect per row. The answer must be identical and
    // the read count logarithmic.
    const ROWS = 128;
    const tops = new Map<number, number>();
    // Rows every 100px, viewport 0..600 → the rows at -400..0 are above the
    // top, those below 600 are past the bottom.
    for (let i = 0; i < ROWS; i++) tops.set(i * 6, i * 100 - 4000);
    const scroller = makeScroller(tops);
    let reads = 0;
    for (const row of Array.from(
      scroller.querySelectorAll<HTMLElement>("[data-abs-index]"),
    )) {
      const idx = Number(row.dataset.absIndex);
      row.getBoundingClientRect = () => {
        reads += 1;
        return {
          top: (idx / 6) * 100 - 4000,
          bottom: (idx / 6) * 100 - 4000 + 40,
        } as DOMRect;
      };
    }
    try {
      const topics = Array.from({ length: ROWS }, (_, i) => topic(i));
      const { container } = renderWithLocale(
        <TopicRail
          topics={topics}
          lang="zh"
          onJump={() => undefined}
          scrollerRef={{ current: scroller }}
        />,
      );
      // Row 40 sits at top 0 and row 46 at 600 (just past the bottom), so the
      // visible span is [row 40's index, row 45's index] = [240, 270] — and
      // topics anchor every 6 record indices, so topics 40..45 ink.
      expect(currentLabels(container)).toEqual([
        "Topic 40",
        "Topic 41",
        "Topic 42",
        "Topic 43",
        "Topic 44",
        "Topic 45",
      ]);
      // log2(128) = 7 per boundary, two boundaries, plus the scroller's own
      // rect. A linear scan would be 128.
      expect(reads).toBeLessThanOrEqual(20);
    } finally {
      scroller.remove();
    }
  });

  it("scrollspy: no scroller ref → no ink (demo/fakes render unchanged)", () => {
    const { container } = renderWithLocale(
      <TopicRail
        topics={[topic(0), topic(1), topic(2)]}
        lang="zh"
        onJump={() => undefined}
      />,
    );
    expect(currentLabels(container)).toEqual([]);
  });

  // ── Windowing (2026-07-27, replacing the ⋯ fold) ────────────────────────

  it("caps at RAIL_MAX_TOPICS and, with no reading position, shows the LATEST", () => {
    const many = Array.from({ length: RAIL_MAX_TOPICS + 8 }, (_, i) =>
      topic(i),
    );
    const { container } = renderWithLocale(
      <TopicRail topics={many} lang="zh" onJump={() => undefined} />,
    );
    const ticks = Array.from(
      container.querySelectorAll<HTMLElement>(".topic-rail__tick"),
    ).map((el) => el.getAttribute("aria-label"));
    expect(ticks).toHaveLength(RAIL_MAX_TOPICS);
    // Clamped to the end — byte-identical to the old collapsed layout, which
    // is what a streaming reader (pinned at the bottom) should see.
    expect(ticks.at(-1)).toBe(`Topic ${many.length - 1}`);
    expect(ticks[0]).toBe(`Topic ${many.length - RAIL_MAX_TOPICS}`);
    // Older history above → faded there, nothing hidden below.
    const list = container.querySelector(".topic-rail__list");
    expect(list?.className).toContain("has-fade-top");
    expect(list?.className).not.toContain("has-fade-bottom");
    // The fold is gone entirely.
    expect(container.querySelector(".topic-rail__more")).toBeNull();
  });

  it("the window FOLLOWS the reading position, and inks it (the fold could not)", () => {
    // The bug this replaced: the window was always slice(-12) while the
    // scrollspy tested every topic, so scrolling back past the last 12 inked
    // NOTHING — the rail stopped reporting a position exactly when the reader
    // was most lost. Window and ink now come from the same measurement.
    const many = Array.from({ length: 40 }, (_, i) => topic(i));
    // Viewport sits on topic 5's region (anchorIndex 30).
    // Row 36 (topic 6's anchor) sits BELOW the 0..600 viewport, so only
    // topic 5's region is on screen — a straddle would legitimately ink two.
    const tops = new Map<number, number>([
      [0, -900],
      [30, -10],
      [36, 700],
    ]);
    const scroller = makeScroller(tops);
    try {
      const { container } = renderWithLocale(
        <TopicRail
          topics={many}
          lang="zh"
          onJump={() => undefined}
          scrollerRef={{ current: scroller }}
        />,
      );
      const labels = Array.from(
        container.querySelectorAll<HTMLElement>(".topic-rail__tick"),
      ).map((el) => el.getAttribute("aria-label"));
      expect(labels).toHaveLength(RAIL_MAX_TOPICS);
      // Topic 5 is IN the window (centred, clamped at the near end)...
      expect(labels).toContain("Topic 5");
      // ...and it inks. Under the fold this list was topics 28..39 and the
      // ink was empty.
      expect(currentLabels(container)).toEqual(["Topic 5"]);
      // History continues BOTH ways from here, so both ends fade.
      const list = container.querySelector(".topic-rail__list");
      expect(list?.className).toContain("has-fade-bottom");
    } finally {
      scroller.remove();
    }
  });

  it("a window slide GLIDES the surviving ticks one pitch — no teleport", () => {
    // A boundary crossing re-maps every tick to a neighbouring topic at
    // once; rendered plainly that is a teleport — each line's meaning
    // changes with nothing moving (user 2026-07-30). The FLIP glide slides
    // each surviving topic's tick to its new slot instead.
    //
    // jsdom has no layout, so tick tops are mocked from DOM order at the
    // rail's 14px pitch — the baseline measure (first layout effect) and the
    // post-slide measure then disagree by exactly one pitch per survivor.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const el = this as HTMLElement;
        const top =
          el.classList.contains("topic-rail__tick") && el.parentElement
            ? 14 * Array.prototype.indexOf.call(el.parentElement.children, el)
            : 0;
        return { top, left: 0 } as DOMRect;
      },
    );
    const animate = vi.fn();
    // jsdom has no Element.animate; install a recording stub.
    (HTMLElement.prototype as unknown as { animate: unknown }).animate =
      animate;
    try {
      // 13 topics, no reading position → window = Topic 1..12.
      const thirteen = Array.from({ length: 13 }, (_, i) => topic(i));
      const { rerender } = renderWithLocale(
        <TopicRail topics={thirteen} lang="zh" onJump={() => undefined} />,
      );
      expect(animate).not.toHaveBeenCalled(); // first layout: nothing to glide from
      // A 14th lands → window = Topic 2..13, every survivor one slot up.
      const fourteen = Array.from({ length: 14 }, (_, i) => topic(i));
      rerender(
        <TopicRail topics={fourteen} lang="zh" onJump={() => undefined} />,
      );
      // The 11 survivors (Topic 2..12) glide from their OLD slot (one pitch
      // below) to none; entering Topic 13 has no prior rect and pops in
      // place — under the end fade, where a tick is already near-invisible.
      expect(animate).toHaveBeenCalledTimes(11);
      for (const call of animate.mock.calls) {
        expect(call[0][0].transform).toBe("translateY(14px)");
      }
    } finally {
      delete (HTMLElement.prototype as unknown as { animate?: unknown })
        .animate;
    }
  });

  it("the card is a hover-time SNAPSHOT — a window slide cannot flip it", () => {
    // 13 topics, no reading position → window = the latest 12 (Topic 1..12).
    // A 14th landing mid-hover slides the window by one: position 0 now
    // holds Topic 2. Re-deriving the card from the position flipped its
    // content with no hover event behind it (2026-07-30); the card must keep
    // the topic the hover EVENT delivered. (In the real renderer the slide
    // remounts the ticks — keyed by anchorIndex — and Chromium re-dispatches
    // mouseenter for the new node under the cursor, refreshing the snapshot
    // at the moment hover truly changes. jsdom fires no such re-dispatch,
    // which is exactly what lets this pin the no-event case.)
    const thirteen = Array.from({ length: 13 }, (_, i) => topic(i));
    const { container, rerender } = renderWithLocale(
      <TopicRail topics={thirteen} lang="zh" onJump={() => undefined} />,
    );
    fireEvent.mouseEnter(screen.getByLabelText("Topic 1"));
    expect(
      container.querySelector(".topic-rail__card-title")?.textContent,
    ).toBe("Topic 1");
    const fourteen = Array.from({ length: 14 }, (_, i) => topic(i));
    rerender(
      <TopicRail topics={fourteen} lang="zh" onJump={() => undefined} />,
    );
    // The window DID slide — position 0 is Topic 2 now…
    const first = container.querySelector(".topic-rail__tick");
    expect(first?.getAttribute("aria-label")).toBe("Topic 2");
    // …but the card did not follow the render math.
    expect(
      container.querySelector(".topic-rail__card-title")?.textContent,
    ).toBe("Topic 1");
    expect(
      container.querySelector(".topic-rail__card-preview")?.textContent,
    ).toBe("question 1");
  });

  it("the exit-fade ghost keeps its content through a window slide", () => {
    // After mouseleave the card fades for 200ms with NO cursor anywhere —
    // there is nothing for re-derived content to be "under", so a slide
    // during the fade flipped a ghost to an unrelated topic.
    const thirteen = Array.from({ length: 13 }, (_, i) => topic(i));
    const { container, rerender } = renderWithLocale(
      <TopicRail topics={thirteen} lang="zh" onJump={() => undefined} />,
    );
    fireEvent.mouseEnter(screen.getByLabelText("Topic 1"));
    fireEvent.mouseLeave(container.querySelector(".topic-rail") as Element);
    // Still mounted (exit animation), no longer open.
    expect(container.querySelector(".topic-rail__card")).not.toBeNull();
    const fourteen = Array.from({ length: 14 }, (_, i) => topic(i));
    rerender(
      <TopicRail topics={fourteen} lang="zh" onJump={() => undefined} />,
    );
    expect(
      container.querySelector(".topic-rail__card-title")?.textContent,
    ).toBe("Topic 1");
  });

  it("railWindowStart: centred, clamped at both ends, and a no-op under the cap", () => {
    const size = 12;
    // Fewer topics than the window → everything, no offset.
    expect(railWindowStart({ total: 8, size, current: 3 })).toBe(0);
    // Mid-history → centred on the current topic.
    expect(railWindowStart({ total: 100, size, current: 50 })).toBe(45);
    // Near the start / end → clamped, never negative, never past the tail.
    expect(railWindowStart({ total: 100, size, current: 1 })).toBe(0);
    expect(railWindowStart({ total: 100, size, current: 99 })).toBe(88);
  });

  it("topicIndexAt: the region containing a record index, -1 before the first", () => {
    const topics = [topic(0), topic(1), topic(2)]; // anchors 0, 6, 12
    expect(topicIndexAt(topics, 0)).toBe(0);
    expect(topicIndexAt(topics, 5)).toBe(0);
    expect(topicIndexAt(topics, 6)).toBe(1);
    expect(topicIndexAt(topics, 99)).toBe(2);
    const later = [topic(2), topic(3)]; // anchors 12, 18
    expect(topicIndexAt(later, 3)).toBe(-1);
  });
});
