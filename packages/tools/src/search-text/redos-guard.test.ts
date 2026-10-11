import { describe, expect, it } from "vitest";
import { hasCatastrophicQuantifier } from "./redos-guard.js";

describe("hasCatastrophicQuantifier (audit 2026-07-13 T2.3)", () => {
  it("rejects the classic nested-unbounded shapes", () => {
    expect(hasCatastrophicQuantifier("(a+)+$")).toBe(true);
    expect(hasCatastrophicQuantifier("(a*)*")).toBe(true);
    expect(hasCatastrophicQuantifier("(?:x+)+y")).toBe(true);
    expect(hasCatastrophicQuantifier("(\\d+)*")).toBe(true);
    expect(hasCatastrophicQuantifier("(a{2,})+")).toBe(true);
    // Nesting through an intermediate group is still nested.
    expect(hasCatastrophicQuantifier("((a+)b)+")).toBe(true);
    // A large bounded repetition of a quantified group behaves the same.
    expect(hasCatastrophicQuantifier("(\\w+,?){1,30}")).toBe(true);
  });

  it("accepts ordinary search patterns", () => {
    expect(hasCatastrophicQuantifier("foo")).toBe(false);
    expect(hasCatastrophicQuantifier("(foo|bar)+")).toBe(false);
    expect(hasCatastrophicQuantifier("\\bconst\\s+\\w+\\s*=")).toBe(false);
    expect(hasCatastrophicQuantifier("[^\\s]+@[^\\s]+")).toBe(false);
    // Bounded small repetition of a quantified group is fine.
    expect(hasCatastrophicQuantifier("(\\w+\\s+){3}\\w+")).toBe(false);
    // `?` on a quantified group is not the exponential shape.
    expect(hasCatastrophicQuantifier("(a+)?b")).toBe(false);
    // Sibling quantified groups don't nest.
    expect(hasCatastrophicQuantifier("(a+)(b+)")).toBe(false);
  });

  it("ignores quantifier-looking text inside classes, escapes, and literal braces", () => {
    expect(hasCatastrophicQuantifier("[(a+)+]")).toBe(false);
    expect(hasCatastrophicQuantifier("\\(a+\\)+")).toBe(false);
    expect(hasCatastrophicQuantifier("(a+)\\+")).toBe(false);
    // A literal '{' that is not a quantifier.
    expect(hasCatastrophicQuantifier("(a+){")).toBe(false);
    expect(hasCatastrophicQuantifier("fn\\(\\) \\{$")).toBe(false);
  });
});
