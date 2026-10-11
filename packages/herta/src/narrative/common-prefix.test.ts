import { describe, expect, it } from "vitest";
import { commonPrefixLen } from "./common-prefix.js";

describe("commonPrefixLen", () => {
  it("returns the code-point length of the longest common prefix", () => {
    expect(commonPrefixLen("ABCDEFG", "ABCJ")).toBe(3);
    expect(commonPrefixLen("", "abc")).toBe(0);
    expect(commonPrefixLen("abc", "")).toBe(0);
    expect(commonPrefixLen("你好世界ABC", "你好世界XYZ")).toBe(4);
    expect(commonPrefixLen("identical", "identical")).toBe(9);
  });

  it("counts code points, not UTF-16 units (surrogate-safe)", () => {
    // "𝄞" is one code point but two UTF-16 units.
    expect(commonPrefixLen("𝄞A", "𝄞B")).toBe(1);
    expect(commonPrefixLen("𝄞", "𝄟")).toBe(0);
  });
});
