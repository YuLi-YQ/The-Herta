/**
 * Fold heredoc BODIES out of a shell command for the approval card.
 *
 * The minimal contract's 板砖 writes files as `cat > path <<'EOF' … EOF`, and
 * the card used to show the whole file inline as "the command" — a wall of
 * monospace under 未识别的命令, cut off at the well's cap (owner 2026-08-17).
 * The rule now attaches the write as a DIFF (and the record gets the same
 * patch preview), so the command box can show the shell line and fold the
 * body: `cat > src/server.mjs <<'EOF'` / `⋯ 24 行，内容见下方差异 ⋯` / `EOF`.
 * The verbatim command is still what the resolver holds and what the CLI
 * prints; this is presentation, applied only when the diff is there to
 * carry the content (the caller checks that).
 *
 * Mirrors the terminator grammar of tools/bash/heredoc-write.ts (`<<-`,
 * quoted / backslashed / bare words). An unterminated heredoc is left as is.
 */
export interface FoldedCommand {
  readonly text: string;
  /** How many heredoc bodies were folded (0 → `text` is the input). */
  readonly folded: number;
}

const HEREDOC_OPEN =
  /<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/;

/** Count the terminated heredocs in a command (to decide whether the diff
 *  covers all of them). */
export function countHeredocs(command: string): number {
  return foldHeredocs(command, () => "").folded;
}

export function foldHeredocs(
  command: string,
  marker: (lines: number) => string,
): FoldedCommand {
  const lines = command.split("\n");
  const out: string[] = [];
  let folded = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    out.push(line);
    const m = HEREDOC_OPEN.exec(line);
    if (m === null) continue;
    const stripTabs = m[1] === "-";
    const terminator = (m[2] ?? m[3] ?? m[4] ?? m[5]) as string;
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j += 1) {
      const raw = lines[j] as string;
      const probe = stripTabs ? raw.replace(/^\t+/, "") : raw;
      if (probe === terminator) {
        closed = true;
        break;
      }
    }
    if (!closed) {
      // Unterminated: keep the rest verbatim.
      out.push(...lines.slice(i + 1));
      break;
    }
    const bodyCount = j - (i + 1);
    if (bodyCount > 0) out.push(marker(bodyCount));
    out.push(lines[j] as string); // the terminator line
    folded += 1;
    i = j;
  }
  return { text: folded === 0 ? command : out.join("\n"), folded };
}
