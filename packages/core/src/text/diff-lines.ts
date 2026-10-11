/**
 * How many lines a unified diff ADDS and REMOVES.
 *
 * One definition, because there were four — in `edit_file`'s tool and its
 * rule, in `str_replace_editor`'s engine, and in the narrative bridge — and
 * all four carried the same defect: they recognised the `---` / `+++` file
 * headers by PREFIX, on every line.
 *
 * A diff line is its marker plus the content, so a deleted line whose text
 * begins with `--` renders as `---…` and was dropped from the count as if it
 * were a header. That is not exotic: YAML front matter, a markdown thematic
 * break, an SQL comment, a `-----` ruler. The `++` side is rarer but the same
 * (`++i`). The counts only ever came out LOW, which is the direction that
 * hides work rather than inventing it — but ADR 0039 lets these numbers reach
 * the record as ground truth, so low is still wrong.
 *
 * The headers are the first two lines of the format and nowhere else, so this
 * skips them BY POSITION and then reads every remaining line as content. A
 * `\` line ("No newline at end of file", the omission markers) is neither an
 * addition nor a removal and is ignored, as before.
 */
export function countDiffLines(diff: string): { add: number; del: number } {
  const lines = diff.split("\n");
  let at = 0;
  if (
    lines[0]?.startsWith("--- ") === true &&
    lines[1]?.startsWith("+++ ") === true
  ) {
    at = 2;
  }
  let add = 0;
  let del = 0;
  for (let i = at; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.startsWith("+")) add += 1;
    else if (line.startsWith("-")) del += 1;
  }
  return { add, del };
}

/** The same count for one side, for callers that only want a total. */
export function countDiffLinesFor(diff: string, prefix: "+" | "-"): number {
  const { add, del } = countDiffLines(diff);
  return prefix === "+" ? add : del;
}
