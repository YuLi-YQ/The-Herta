import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiffStat } from "./DiffStat.js";

/**
 * jsdom HAS `requestAnimationFrame`, so the count-up really runs here: the
 * first frame is 0 and the digits climb to the target. These assertions wait
 * for the settled value, which is the contract that matters — however the
 * numbers arrive, they must end up right, and an unmeasured change must never
 * arrive at `+0 −0`.
 *
 * The count-up plays only for a LIVE append (a block stamped seconds ago) —
 * `liveAt` below is that stamp. History renders settled; see the recency
 * tests at the bottom.
 *
 * The sign and digits are separate text nodes (`{"+"}{n}`), so these read
 * `textContent` rather than `getByText`.
 */
const liveAt = (): string => new Date().toISOString();

describe("DiffStat", () => {
  it("settles on both counts, with a real minus sign", async () => {
    const { container } = render(
      <DiffStat value={{ add: 96, del: 5 }} at={liveAt()} />,
    );
    await waitFor(() => {
      // U+2212, not a hyphen: it aligns with `+` in a monospace column.
      expect(container.textContent).toBe("+96−5");
    });
  });

  it("renders a genuine zero, which is not the same as unmeasured", async () => {
    const { container } = render(
      <DiffStat value={{ add: 12, del: 0 }} at={liveAt()} />,
    );
    await waitFor(() => expect(container.textContent).toBe("+12−0"));
  });

  it("says NOTHING when the change was not measured", () => {
    // Owner, 2026-08-25 evening: the first version spelled this out as
    // `已改动（命令，无逐行差异）` — a sentence about the absence of a number,
    // on a row that already names the file it changed. Silence is the honest
    // rendering; a `+0 −0` never becomes acceptable.
    const { container } = render(<DiffStat value="unmeasured" />);
    expect(container.textContent).toBe("");
    expect(container.querySelector(".diff-stat")).toBeNull();
  });

  it("marks the roll-up so it can read as a total, not another row", () => {
    const { container } = render(
      <DiffStat value={{ add: 187, del: 42 }} rollup />,
    );
    expect(container.querySelector(".diff-stat--rollup")).toBeTruthy();
  });

  it("never shows a value outside 0…target, whatever the clock does", async () => {
    // The rAF timestamp and `performance.now()` need not share a time origin —
    // under jsdom they do not, and taking the difference produced a large
    // NEGATIVE count through the cubic easing (`+-28355`). Every intermediate
    // value must be a number the file could actually have.
    const seen: string[] = [];
    const { container } = render(
      <DiffStat value={{ add: 12, del: 0 }} at={liveAt()} />,
    );
    for (let i = 0; i < 12; i += 1) {
      seen.push(container.textContent ?? "");
      await new Promise((r) => setTimeout(r, 40));
    }
    await waitFor(() => expect(container.textContent).toBe("+12−0"));
    for (const s of seen) {
      expect(s.startsWith("+-"), s).toBe(false);
      const n = Number.parseInt(s.replace("+", "").split("−")[0] ?? "", 10);
      expect(n >= 0 && n <= 12, s).toBe(true);
    }
  });

  it("counts UP — the first frame is not already the answer", () => {
    // The magnitude arriving is what draws the eye in a column of static
    // text; if it rendered settled there would be nothing to notice.
    const { container } = render(
      <DiffStat value={{ add: 500, del: 0 }} at={liveAt()} />,
    );
    expect(container.textContent).not.toBe("+500−0");
    // The CSS entrance rides the same gate: only a live row carries the class.
    expect(container.querySelector(".diff-stat--live")).toBeTruthy();
  });

  it("history renders settled immediately — never replays the entrance", () => {
    // A session switch or reload mounts blocks that are minutes old. Playing
    // every historical dispatch's count-up at once is the exact class the
    // live-attach entrance gate exists to prevent (ActivityBlock, 2026-08-10);
    // the magnitude follows the same rule: decided once at mount, off the
    // block's own `at` stamp.
    const at = new Date(Date.now() - 60_000).toISOString();
    const { container } = render(
      <DiffStat value={{ add: 96, del: 5 }} at={at} />,
    );
    expect(container.textContent).toBe("+96−5");
    expect(container.querySelector(".diff-stat--live")).toBeNull();
  });

  it("a record with no stamp at all is history too", () => {
    // Pre-timestamp sessions lack `at` entirely (it arrived late, optional
    // for backward compat). Absent evidence of a live append, render settled —
    // the animation is a claim about NOW, not about the value.
    const { container } = render(<DiffStat value={{ add: 12, del: 3 }} />);
    expect(container.textContent).toBe("+12−3");
    expect(container.querySelector(".diff-stat--live")).toBeNull();
  });
});
