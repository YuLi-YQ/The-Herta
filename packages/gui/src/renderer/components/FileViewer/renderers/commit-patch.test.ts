import { describe, expect, it } from "vitest";
import {
  commitTotals,
  formatCommitDate,
  splitPatchByFile,
} from "./commit-patch.js";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  " one",
  "-two",
  "+three",
  "diff --git a/pic.png b/pic.png",
  "new file mode 100644",
  "index 0000000..3333333",
  "Binary files /dev/null and b/pic.png differ",
  "diff --git a/old.ts b/moved.ts",
  "similarity index 100%",
  "rename from old.ts",
  "rename to moved.ts",
  "",
].join("\n");

describe("splitPatchByFile (ADR 0059)", () => {
  it("cuts one section per diff header, drops the header lines, keeps the hunks", () => {
    const s = splitPatchByFile(PATCH);
    expect(s).toHaveLength(3);
    expect(s[0]).toBe("@@ -1,2 +1,2 @@\n one\n-two\n+three");
    // A binary file: the statement rides as an aside, not as content.
    expect(s[1]).toBe("\\ Binary files /dev/null and b/pic.png differ");
    // A pure rename has no hunks at all.
    expect(s[2]).toBe("");
  });

  it("an empty patch has no sections; text before the first header is ignored", () => {
    expect(splitPatchByFile("")).toEqual([]);
    expect(splitPatchByFile("stray\n")).toEqual([]);
  });
});

describe("commitTotals", () => {
  it("sums the counted files and leaves binaries out", () => {
    expect(
      commitTotals([
        { path: "a", status: "modified", added: 3, deleted: 1 },
        { path: "b", status: "added", added: null, deleted: null },
        { path: "c", status: "deleted", added: 0, deleted: 7 },
      ]),
    ).toEqual({ added: 3, deleted: 8 });
  });
});

describe("formatCommitDate", () => {
  it("spells the date in the UI locale, 24-hour, and answers empty for garbage", () => {
    expect(formatCommitDate("2026-09-07T15:02:00+08:00", "en", "UTC")).toBe(
      "Sep 7, 2026, 07:02",
    );
    expect(formatCommitDate("2026-09-07T15:02:00+08:00", "zh", "UTC")).toMatch(
      /2026.*9.*7.*07:02/,
    );
    expect(formatCommitDate("not a date", "en")).toBe("");
  });
});
