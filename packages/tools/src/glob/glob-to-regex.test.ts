import { describe, expect, it } from "vitest";
import { globToRegExp } from "./glob-to-regex.js";

function matches(pattern: string, path: string): boolean {
  const re = globToRegExp(pattern);
  if (re === null) throw new Error(`pattern rejected: ${pattern}`);
  return re.test(path);
}

describe("globToRegExp", () => {
  it("* stays within one segment", () => {
    expect(matches("*.ts", "a.ts")).toBe(true);
    expect(matches("*.ts", "src/a.ts")).toBe(false);
    expect(matches("src/*.ts", "src/a.ts")).toBe(true);
    expect(matches("src/*.ts", "src/deep/a.ts")).toBe(false);
  });

  it("** spans any number of segments, including none", () => {
    expect(matches("**/*.ts", "a.ts")).toBe(true);
    expect(matches("**/*.ts", "src/a.ts")).toBe(true);
    expect(matches("**/*.ts", "src/very/deep/a.ts")).toBe(true);
    expect(matches("**/*.ts", "src/a.js")).toBe(false);
    expect(matches("src/**", "src/a.ts")).toBe(true);
    expect(matches("src/**", "src/deep/b.js")).toBe(true);
    expect(matches("src/**", "other/a.ts")).toBe(false);
    expect(matches("src/**/index.ts", "src/index.ts")).toBe(true);
    expect(matches("src/**/index.ts", "src/a/b/index.ts")).toBe(true);
  });

  it("? matches exactly one non-separator character", () => {
    expect(matches("a?c.txt", "abc.txt")).toBe(true);
    expect(matches("a?c.txt", "ac.txt")).toBe(false);
    expect(matches("a?c.txt", "a/c.txt")).toBe(false);
  });

  it("character classes, with ! negation", () => {
    expect(matches("[ab]x.txt", "ax.txt")).toBe(true);
    expect(matches("[ab]x.txt", "cx.txt")).toBe(false);
    expect(matches("[!ab]x.txt", "cx.txt")).toBe(true);
    expect(matches("[!ab]x.txt", "ax.txt")).toBe(false);
  });

  it("{a,b} alternation", () => {
    expect(matches("{src,packages}/**/*.ts", "src/a.ts")).toBe(true);
    expect(matches("{src,packages}/**/*.ts", "packages/x/b.ts")).toBe(true);
    expect(matches("{src,packages}/**/*.ts", "scripts/c.ts")).toBe(false);
    // Commas outside braces stay literal.
    expect(matches("a,b.txt", "a,b.txt")).toBe(true);
  });

  it("escapes regex metacharacters in literals", () => {
    expect(matches("a.b.txt", "a.b.txt")).toBe(true);
    expect(matches("a.b.txt", "aXb.txt")).toBe(false);
    expect(matches("a+(b).txt", "a+(b).txt")).toBe(true);
  });

  it("rejects malformed patterns", () => {
    expect(globToRegExp("{unclosed")).toBeNull();
    expect(globToRegExp("un}balanced")).toBeNull();
    expect(globToRegExp("{a,{b,c}}")).toBeNull(); // no nesting
    expect(globToRegExp("[unclosed")).toBeNull();
  });
});
