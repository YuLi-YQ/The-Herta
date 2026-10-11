import { describe, expect, it } from "vitest";
import { boundedTail } from "./bounded-tail.js";

describe("boundedTail", () => {
  it("returns stdout tail when stdout is present", () => {
    const out = boundedTail("line1\nline2\nline3", "", {});
    expect(out.text).toContain("line3");
    expect(out.truncated).toBe(false);
  });

  it("falls back to stderr (labeled) when stdout is empty", () => {
    const out = boundedTail("", "err line", {});
    expect(out.text).toContain("err line");
    expect(out.text.toLowerCase()).toContain("stderr");
  });

  it("includes both streams with the [stderr] label when both are present", () => {
    const out = boundedTail("out line A\nout line B", "err X\nerr Y", {});
    expect(out.text).toContain("out line B");
    expect(out.text).toContain("err Y");
    expect(out.text).toContain("[stderr]");
  });

  it("keeps the [stderr] label even when stdout overflows the line cap", () => {
    const bigStdout = Array.from({ length: 40 }, (_, i) => `O${i}`).join("\n");
    const out = boundedTail(bigStdout, "err tail line", { maxLines: 15 });
    // stdout is tail-capped but the stderr label + content survive (the bug).
    expect(out.text).toContain("[stderr]");
    expect(out.text).toContain("err tail line");
    expect(out.text).toContain("O39"); // stdout tail kept
    expect(out.truncated).toBe(true);
  });

  it("takes the LAST lines when over the line cap", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `L${i}`).join("\n");
    const out = boundedTail(lines, "", { maxLines: 15 });
    expect(out.text).toContain("L39"); // last line kept
    expect(out.text).not.toContain("L0"); // first line dropped
    expect(out.truncated).toBe(true);
  });

  it("caps by chars too", () => {
    const out = boundedTail("x".repeat(2000), "", { maxChars: 800 });
    expect(out.text.length).toBeLessThanOrEqual(900); // 800 + marker slack
    expect(out.truncated).toBe(true);
  });

  it("appends a truncation marker with the log path when clipped", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `L${i}`).join("\n");
    const out = boundedTail(lines, "", {
      maxLines: 15,
      logPath: ".herta/logs/x.log",
    });
    expect(out.text).toContain("truncated");
    expect(out.text).toContain(".herta/logs/x.log");
  });

  it("honors a pre-flagged source truncation even when within caps", () => {
    const out = boundedTail("short", "", {
      sourceTruncated: true,
      logPath: "L",
    });
    expect(out.truncated).toBe(true);
    expect(out.text).toContain("truncated");
  });

  it("returns empty for empty input, never throws", () => {
    const out = boundedTail("", "", {});
    expect(out.text).toBe("");
    expect(out.truncated).toBe(false);
  });
});
