import { describe, expect, it } from "vitest";
import { countDiffLines, countDiffLinesFor } from "./diff-lines.js";

const diff = (...body: string[]): string =>
  ["--- a/x.md", "+++ b/x.md", ...body].join("\n");

describe("countDiffLines", () => {
  it("counts a plain diff", () => {
    expect(countDiffLines(diff(" ctx", "-old", "+new"))).toEqual({
      add: 1,
      del: 1,
    });
  });

  it("counts content lines that begin with -- and ++", () => {
    // The defect this exists to pin: the file headers were recognised by
    // PREFIX on every line, so a deleted line whose TEXT starts with `--`
    // rendered as `---…` and was skipped as if it were a header. YAML front
    // matter, a markdown rule, an SQL comment. Four copies of this function
    // had it; the counts only ever came out low, and ADR 0039 lets them reach
    // the record as ground truth.
    expect(countDiffLines(diff("-a", "---", "---sep", "-b", "+new"))).toEqual({
      add: 1,
      del: 4,
    });
    expect(countDiffLines(diff("+a", "+++i", "-x"))).toEqual({
      add: 2,
      del: 1,
    });
  });

  it("ignores the `\\` marker lines", () => {
    expect(
      countDiffLines(
        diff("\\ 12 unchanged lines omitted", "-old", "+new", "\\ No newline"),
      ),
    ).toEqual({ add: 1, del: 1 });
  });

  it("skips the headers by POSITION, and only when they are there", () => {
    expect(countDiffLines(diff())).toEqual({ add: 0, del: 0 });
    // A bare body with no header block still counts every line.
    expect(countDiffLines("-a\n+b")).toEqual({ add: 1, del: 1 });
  });

  it("countDiffLinesFor picks one side", () => {
    const d = diff("-a", "---", "+b");
    expect(countDiffLinesFor(d, "-")).toBe(2);
    expect(countDiffLinesFor(d, "+")).toBe(1);
  });
});
