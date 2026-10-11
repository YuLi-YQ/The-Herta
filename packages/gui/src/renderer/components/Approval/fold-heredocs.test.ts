import { describe, expect, it } from "vitest";
import { countHeredocs, foldHeredocs } from "./fold-heredocs.js";

const marker = (n: number) => `⋯ ${n} ⋯`;

describe("foldHeredocs", () => {
  it("folds the body between the `<<WORD` line and its terminator, keeping both", () => {
    const cmd = "cat > a.txt <<'EOF'\nline 1\nline 2\nEOF";
    expect(foldHeredocs(cmd, marker)).toEqual({
      text: "cat > a.txt <<'EOF'\n⋯ 2 ⋯\nEOF",
      folded: 1,
    });
    expect(countHeredocs(cmd)).toBe(1);
  });

  it("handles quoted / bare / backslashed words, `<<-` with tabbed bodies, and several heredocs", () => {
    const cmd = [
      'cat > a <<"A"',
      "x",
      "A",
      "cat <<-B > b",
      "\ty",
      "\tB",
      "cat > c <<\\C",
      "z",
      "C",
      "echo done",
    ].join("\n");
    const out = foldHeredocs(cmd, marker);
    expect(out.folded).toBe(3);
    expect(out.text).toBe(
      [
        'cat > a <<"A"',
        "⋯ 1 ⋯",
        "A",
        "cat <<-B > b",
        "⋯ 1 ⋯",
        "\tB",
        "cat > c <<\\C",
        "⋯ 1 ⋯",
        "C",
        "echo done",
      ].join("\n"),
    );
  });

  it("an empty body gets no marker; an unterminated heredoc is left verbatim; no heredoc → input unchanged", () => {
    expect(foldHeredocs("cat > a <<'E'\nE", marker).text).toBe(
      "cat > a <<'E'\nE",
    );
    const open = "cat > a <<'E'\nnever closed";
    expect(foldHeredocs(open, marker)).toEqual({ text: open, folded: 0 });
    expect(foldHeredocs("ls -la", marker)).toEqual({
      text: "ls -la",
      folded: 0,
    });
  });
});
