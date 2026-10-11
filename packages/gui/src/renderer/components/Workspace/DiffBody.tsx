import { memo } from "react";

/** One diff line's role, decided by its first character. */
type DiffLineKind = "add" | "del" | "hunk" | "file" | "meta" | "ctx";

/**
 * Classify a unified-diff line.
 *
 * `+++` / `---` are checked BEFORE `+` / `-`: a file header is not content,
 * and colouring it as an addition is exactly the mistake that makes a diff
 * read as one line larger than it is on each side (the same reason
 * `countDiffLines` skips them).
 *
 * A `\ ` line is the omission marker the bounded differ emits
 * (`\ 412 unchanged lines omitted`, `\ No newline at end of file`) — a
 * statement ABOUT the diff, so it gets the quiet treatment rather than a sign.
 */
function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "file";
  if (line.startsWith("diff --git") || line.startsWith("index ")) return "file";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("\\")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

/** The sign shown in the gutter. Context and prose carry none. */
const GUTTER: Record<DiffLineKind, string> = {
  add: "+",
  del: "−",
  hunk: "",
  file: "",
  meta: "\\",
  ctx: "",
};

export interface DiffBodyProps {
  /** Diff content WITHOUT the ```diff fence (`summarizeDiff().diffText`). */
  readonly text: string;
  /**
   * Rendering inside the approval card's dark preview well, which already
   * supplies the box (background, border, radius) and whose colours are fixed
   * in BOTH themes — so this variant drops its own chrome and uses tints that
   * read on `#0f172a` instead of the theme tokens.
   */
  readonly onDark?: boolean;
}

/**
 * A rendered diff: one row per line, tinted by role, with the sign moved out
 * of the text into a fixed gutter.
 *
 * Before this the diff was a single `<pre>` of the raw fenced body — every
 * line the same weight, the `+`/`-` doing all the work, and the ``` fences
 * themselves on screen. The change is legibility only: the text of each line
 * is the record's text, untouched (D7), and no line is dropped or reordered.
 *
 * Deliberately NO line numbers. The patch previews this renders carry no `@@`
 * anchors (the differ emits plain ` `/`+`/`-` runs with omission markers), so
 * any number in that gutter would be inferred rather than measured — the same
 * class of fabrication this row's `+N −M` was careful to avoid.
 *
 * Memoized (perf audit 2026-09-20): both props are primitives, so the
 * comparison is exact, and this is the heavy leaf — a patch is capped at
 * 200 000 characters, about 5 000 rows of three elements. Its parents
 * re-render for reasons that cannot change a diff: the file viewer on every
 * pointer move of its divider and every frame of a sidebar slide (its width
 * is state), an activity row whenever its group's live timer ticks.
 */
export const DiffBody = memo(function DiffBody(
  props: DiffBodyProps,
): JSX.Element {
  const lines = props.text.split("\n");
  return (
    <div
      className={`diff-body${props.onDark === true ? " diff-body--on-dark" : ""}`}
    >
      {lines.map((line, i) => {
        const kind = diffLineKind(line);
        // The mark lives in the gutter, so strip it from the text — but only
        // for the kinds that HAVE one. A context line's leading space is part
        // of the format, not content, so it goes too; a `\ ` marker sheds its
        // backslash AND the space after it (found in the lab: the row read
        // `\  \ 412 unchanged lines omitted`).
        const text =
          kind === "meta"
            ? line.replace(/^\\ ?/, "")
            : kind === "add" || kind === "del" || kind === "ctx"
              ? line.slice(1)
              : line;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines repeat verbatim (blank lines, closing braces) so text is not an identity; the array is a pure projection of one immutable string, rebuilt whole whenever it changes.
            key={i}
            className={`diff-body__line is-${kind}`}
          >
            <span className="diff-body__gutter" aria-hidden="true">
              {GUTTER[kind]}
            </span>
            <span className="diff-body__text">{text}</span>
          </div>
        );
      })}
    </div>
  );
});
