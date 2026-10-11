import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatInputIssues } from "./input-issues.js";
import { showExcerptInputSchema } from "./show-excerpt/schema.js";

describe("formatInputIssues", () => {
  it("renders field-level issues as `field: message`", () => {
    const r = z.object({ path: z.string() }).safeParse({ path: 5 });
    if (r.success) throw new Error("expected failure");
    expect(formatInputIssues(r.error)).toMatch(/^path: /);
  });

  it("renders root-level refine issues WITHOUT a dangling colon", () => {
    // The doubled-colon record line (user 2026-07-31): a root refine has an
    // empty path, and the old per-tool `path.join + ': '` produced ": give
    // either `match` or `fromLine`" → "invalid_input: : give…" in the record.
    // (That refine is gone — a bare path is valid since 2026-09-18 — so the
    // schema's other root refine, the range order, exercises the same path.)
    const r = showExcerptInputSchema.safeParse({
      path: "a.txt",
      fromLine: 5,
      toLine: 2,
    });
    if (r.success) throw new Error("expected failure");
    const msg = formatInputIssues(r.error);
    expect(msg).toBe("toLine must be >= fromLine");
    expect(msg.startsWith(":")).toBe(false);
  });

  it("names unrecognized keys instead of stripping them (strict schemas)", () => {
    // The live failure this guards: the model passed a range under wrong key
    // names; non-strict zod stripped them and the refine then claimed no
    // range was given at all — technically true, actually misleading.
    const r = showExcerptInputSchema.safeParse({
      path: "a.txt",
      from: 1,
      to: 40,
    });
    if (r.success) throw new Error("expected failure");
    const msg = formatInputIssues(r.error);
    expect(msg).toContain("from");
    expect(msg).toContain("to");
    expect(msg).toMatch(/[Uu]nrecognized/);
  });
});
