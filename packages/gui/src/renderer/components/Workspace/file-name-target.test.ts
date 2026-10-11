import { describe, expect, it } from "vitest";
import {
  opTarget,
  parseCite,
  segmentByTargets,
  splitBodyAtPath,
} from "./file-name-target.js";

describe("splitBodyAtPath (ADR 0050 §1)", () => {
  it("splits a localized body around the digest's verbatim path", () => {
    expect(
      splitBodyAtPath("已创建 random-84a57f.txt", "random-84a57f.txt"),
    ).toEqual({
      before: "已创建 ",
      name: "random-84a57f.txt",
      after: "",
    });
    expect(splitBodyAtPath("Writing src/x.ts +2 −0", "src/x.ts")).toEqual({
      before: "Writing ",
      name: "src/x.ts",
      after: " +2 −0",
    });
  });

  it("takes the LAST occurrence — the arg position, not a verb collision", () => {
    const r = splitBodyAtPath("a a/b then a/b", "a/b");
    expect(r?.before).toBe("a a/b then ");
  });

  it("degrades to null when the body no longer carries the path", () => {
    expect(splitBodyAtPath("已创建 something-else.txt", "src/x.ts")).toBeNull();
    expect(splitBodyAtPath("body", "")).toBeNull();
  });
});

describe("parseCite (ADR 0050 v1.5)", () => {
  it("parses line and range cites into anchors", () => {
    expect(parseCite("src/x.ts:12")).toEqual({
      path: "src/x.ts",
      anchor: { from: 12, to: 12 },
    });
    expect(parseCite("src/x.ts:12-30")).toEqual({
      path: "src/x.ts",
      anchor: { from: 12, to: 30 },
    });
  });

  it("a bare path opens plain; garbage stays text", () => {
    expect(parseCite("README.md")).toEqual({ path: "README.md" });
    expect(parseCite("src/x.ts:0")).toBeNull(); // lines are 1-based
    expect(parseCite("src/x.ts:30-12")).toBeNull(); // inverted range
    expect(parseCite("")).toBeNull();
    // A colon with no line shape (a drive-letter-ish or prose cite) is not
    // a control.
    expect(parseCite("see the log: everywhere")).toBeNull();
  });
});

describe("opTarget (ADR 0050 v1.5)", () => {
  it("an excerpt-range arg opens the real file at those lines", () => {
    expect(opTarget("viewer-demo.txt:2-8")).toEqual({
      path: "viewer-demo.txt",
      name: "viewer-demo.txt:2-8",
      anchor: { from: 2, to: 8 },
    });
    expect(opTarget("a.ts:5")).toEqual({
      path: "a.ts",
      name: "a.ts:5",
      anchor: { from: 5, to: 5 },
    });
  });

  it("a plain path (or an odd colon shape) passes through verbatim", () => {
    expect(opTarget("src/x.ts")).toEqual({ path: "src/x.ts" });
    // Not a line shape — keep the arg as the path rather than guessing.
    expect(opTarget("weird:name")).toEqual({ path: "weird:name" });
  });
});

describe("segmentByTargets (ADR 0050 v1.5)", () => {
  it("wraps each target's first occurrence, in document order", () => {
    const s = segmentByTargets("结论: 见 a.ts:1-3, b.ts:5 两处", [
      "a.ts:1-3",
      "b.ts:5",
    ]);
    expect(s).toEqual([
      { kind: "text", text: "结论: 见 " },
      { kind: "target", text: "a.ts:1-3", index: 0 },
      { kind: "text", text: ", " },
      { kind: "target", text: "b.ts:5", index: 1 },
      { kind: "text", text: " 两处" },
    ]);
  });

  it("skips absent targets and returns one plain segment on no hits", () => {
    expect(segmentByTargets("nothing here", ["x.ts"])).toEqual([
      { kind: "text", text: "nothing here" },
    ]);
    const s = segmentByTargets("only b.ts present", ["a.ts", "b.ts"]);
    expect(s.filter((x) => x.kind === "target")).toEqual([
      { kind: "target", text: "b.ts", index: 1 },
    ]);
  });

  it("never overlaps when one target is a substring chasing another", () => {
    const s = segmentByTargets("a.ts a.ts:5", ["a.ts", "a.ts:5"]);
    expect(s).toEqual([
      { kind: "target", text: "a.ts", index: 0 },
      { kind: "text", text: " " },
      { kind: "target", text: "a.ts:5", index: 1 },
    ]);
  });
});
