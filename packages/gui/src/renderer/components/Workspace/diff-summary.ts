/** Default max diff lines shown before a block collapses. Mirrors the CLI's
 *  DEFAULT_DIFF_PREVIEW_MAX_LINES. */
export const DIFF_COLLAPSE_THRESHOLD = 20;

export interface DiffSummary {
  /** A ```diff fence was found in the body. */
  readonly hasDiff: boolean;
  /** Text before the fence (e.g. the "patch preview: …" header), trailing newline kept. */
  readonly preText: string;
  /** The diff content between the fences. */
  readonly diffText: string;
  /** Number of diff content lines. */
  readonly diffLineCount: number;
  /** Added lines ('+' prefix), excluding the '+++' file header. */
  readonly addCount: number;
  /** Removed lines ('-' prefix), excluding the '---' file header. */
  readonly delCount: number;
}

/**
 * Parse a system/backend block body into its pre-fence text and the fenced
 * diff. A body with no ```diff fence reports hasDiff:false. An unclosed fence
 * is treated as diff content to the end (matching the CLI's diff-collapse).
 */
export function summarizeDiff(body: string): DiffSummary {
  const lines = body.split("\n");
  const open = lines.indexOf("```diff");
  if (open === -1) {
    return {
      hasDiff: false,
      preText: body,
      diffText: "",
      diffLineCount: 0,
      addCount: 0,
      delCount: 0,
    };
  }
  let close = open + 1;
  while (close < lines.length && lines[close] !== "```") close += 1;
  const preText = lines.slice(0, open).join("\n");
  const diffLines = lines.slice(open + 1, close);
  let addCount = 0;
  let delCount = 0;
  for (const line of diffLines) {
    if (line.startsWith("+") && !line.startsWith("+++")) addCount += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) delCount += 1;
  }
  return {
    hasDiff: true,
    preText,
    diffText: diffLines.join("\n"),
    diffLineCount: diffLines.length,
    addCount,
    delCount,
  };
}
