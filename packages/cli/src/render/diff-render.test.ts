import { describe, expect, it } from "vitest";
import { renderDiff } from "./diff-render.js";
import { makeStyle } from "./style.js";

const plain = makeStyle({ enabled: false });
const colored = makeStyle({ enabled: true });

describe("renderDiff", () => {
  it("returns empty string for empty input", () => {
    expect(renderDiff("", plain, { maxLines: 12 })).toBe("");
  });

  it("renders short diffs in full", () => {
    const diff = `--- a/x.txt\n+++ b/x.txt\n@@ -1,1 +1,1 @@\n-old\n+new`;
    const out = renderDiff(diff, plain, { maxLines: 12 });
    expect(out).toContain("--- a/x.txt");
    expect(out).toContain("+++ b/x.txt");
    expect(out).toContain("-old");
    expect(out).toContain("+new");
  });

  it("clamps long diffs and appends suppression marker", () => {
    const lines = ["--- a/x", "+++ b/x"];
    for (let i = 0; i < 30; i++) lines.push(`+line${i}`);
    const diff = lines.join("\n");
    const out = renderDiff(diff, plain, { maxLines: 12 });
    expect(out).toContain("more lines suppressed");
    expect(out.split("\n").length).toBeLessThanOrEqual(13);
  });

  it("colors +/- lines and dims headers when style enabled", () => {
    const diff = `--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-old\n+new`;
    const out = renderDiff(diff, colored, { maxLines: 12 });
    expect(out).toContain("\x1b[31m-old\x1b[0m");
    expect(out).toContain("\x1b[32m+new\x1b[0m");
    expect(out).toContain("\x1b[2m--- a/x\x1b[0m");
    expect(out).toContain("\x1b[2m@@ -1,1 +1,1 @@\x1b[0m");
  });
});
