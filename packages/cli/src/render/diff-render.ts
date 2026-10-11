import type { Style } from "./style.js";

export interface DiffRenderOpts {
  maxLines: number;
}

export function renderDiff(
  diff: string,
  style: Style,
  opts: DiffRenderOpts,
): string {
  if (diff.length === 0) return "";
  const lines = diff.split("\n");
  const limit = Math.max(1, opts.maxLines);
  const truncated = lines.length > limit;
  const visible = truncated ? lines.slice(0, limit - 1) : lines;
  const out: string[] = [];
  for (const line of visible) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      out.push(style.dim(line));
    } else if (line.startsWith("@@")) {
      out.push(style.dim(line));
    } else if (line.startsWith("\\")) {
      out.push(style.dim(line));
    } else if (line.startsWith("+")) {
      out.push(style.green(line));
    } else if (line.startsWith("-")) {
      out.push(style.red(line));
    } else {
      out.push(line);
    }
  }
  if (truncated) {
    const remaining = lines.length - (limit - 1);
    out.push(style.dim(`… (${remaining} more lines suppressed)`));
  }
  return out.join("\n");
}
