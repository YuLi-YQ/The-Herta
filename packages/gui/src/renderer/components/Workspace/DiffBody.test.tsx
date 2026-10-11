import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiffBody } from "./DiffBody.js";

const kinds = (container: HTMLElement): string[] =>
  [...container.querySelectorAll(".diff-body__line")].map((el) =>
    el.className.replace("diff-body__line is-", ""),
  );

const texts = (container: HTMLElement): string[] =>
  [...container.querySelectorAll(".diff-body__text")].map(
    (el) => el.textContent ?? "",
  );

describe("DiffBody", () => {
  it("classifies content, headers, hunks and omission markers", () => {
    const { container } = render(
      <DiffBody
        text={[
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -1,3 +1,3 @@",
          " const a = 1;",
          "-const b = 2;",
          "+const b = 3;",
          "\\ 412 unchanged lines omitted",
        ].join("\n")}
      />,
    );
    expect(kinds(container)).toEqual([
      // `---`/`+++` are file headers, NOT a deletion and an addition — the
      // mistake that reads every single-file patch as one line larger on
      // each side.
      "file",
      "file",
      "hunk",
      "ctx",
      "del",
      "add",
      "meta",
    ]);
  });

  it("moves the sign into the gutter and leaves the code alone", () => {
    const { container } = render(
      <DiffBody text={[" keep", "-old", "+new"].join("\n")} />,
    );
    expect(texts(container)).toEqual(["keep", "old", "new"]);
    const gutters = [...container.querySelectorAll(".diff-body__gutter")].map(
      (el) => el.textContent,
    );
    // U+2212, matching the `−` in the row's `+N −M` stat.
    expect(gutters).toEqual(["", "−", "+"]);
  });

  it("keeps a blank line as a line", () => {
    // A row per line, or the diff appears to skip lines it did not skip.
    const { container } = render(<DiffBody text={"+a\n+\n+b"} />);
    expect(container.querySelectorAll(".diff-body__line")).toHaveLength(3);
    expect(texts(container)).toEqual(["a", "", "b"]);
  });

  it("does not invent line numbers", () => {
    // These previews carry no @@ anchors, so any number in the gutter would
    // be inferred — the same class of fabrication the `+N −M` avoids.
    const { container } = render(<DiffBody text={"+a\n+b\n+c"} />);
    expect(container.textContent).toBe("+a+b+c");
  });

  it("preserves leading whitespace in the code it shows", () => {
    const { container } = render(<DiffBody text={"+    indented()"} />);
    expect(texts(container)).toEqual(["    indented()"]);
  });
});
