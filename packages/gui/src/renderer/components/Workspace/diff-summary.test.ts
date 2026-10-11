import { describe, expect, it } from "vitest";
import { DIFF_COLLAPSE_THRESHOLD, summarizeDiff } from "./diff-summary.js";

describe("summarizeDiff", () => {
  it("reports no diff for a plain body", () => {
    const s = summarizeDiff("Reading scripts");
    expect(s.hasDiff).toBe(false);
    expect(s.diffLineCount).toBe(0);
  });

  it("splits preText from the fenced diff and counts lines", () => {
    const body = [
      "patch preview: a.ts",
      "",
      "```diff",
      "--- /dev/null",
      "+++ b/a.ts",
      "+const x = 1;",
      "+const y = 2;",
      "-old line",
      "```",
    ].join("\n");
    const s = summarizeDiff(body);
    expect(s.hasDiff).toBe(true);
    expect(s.preText).toBe("patch preview: a.ts\n");
    expect(s.diffLineCount).toBe(5);
    expect(s.addCount).toBe(2); // excludes the +++ header
    expect(s.delCount).toBe(1); // excludes the --- header
  });

  it("treats an unclosed fence as diff content to the end", () => {
    const body = ["```diff", "+a", "+b"].join("\n");
    const s = summarizeDiff(body);
    expect(s.hasDiff).toBe(true);
    expect(s.diffLineCount).toBe(2);
  });

  it("exposes a default threshold of 20", () => {
    expect(DIFF_COLLAPSE_THRESHOLD).toBe(20);
  });
});
