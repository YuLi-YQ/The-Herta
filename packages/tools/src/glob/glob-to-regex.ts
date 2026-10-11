/**
 * Zero-dependency glob → RegExp translator (ADR 0025 slice 3). Supports
 * the subset a code-navigation glob actually needs:
 *
 *   **   any number of path segments (including none)
 *   *    anything within one segment
 *   ?    one character within a segment
 *   [..] character class (leading ! negates, like shell globs)
 *   {a,b} alternation (no nesting)
 *
 * Patterns match the WHOLE search-root-relative POSIX path. Returns null
 * for malformed patterns (unclosed class/brace, nested braces) so the
 * tool can reject them as invalid_pattern instead of mis-matching.
 */
export function globToRegExp(pattern: string): RegExp | null {
  let out = "";
  let i = 0;
  let braceDepth = 0;

  const escapeChar = (c: string): string =>
    /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;

  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === "*") {
      const isDouble = pattern[i + 1] === "*";
      if (isDouble) {
        // "**/" → zero or more whole segments; trailing/bare "**" → rest.
        if (pattern[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (c === "[") {
      const end = pattern.indexOf("]", i + 2); // "]" first in class is literal
      if (end < 0) return null;
      let body = pattern.slice(i + 1, end);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      // Forbid class characters that would break out of the bracket.
      if (body.includes("[") || body.includes("\\")) return null;
      out += `[${body}]`;
      i = end + 1;
      continue;
    }
    if (c === "{") {
      if (braceDepth > 0) return null;
      braceDepth += 1;
      out += "(?:";
      i += 1;
      continue;
    }
    if (c === ",") {
      if (braceDepth > 0) {
        out += "|";
      } else {
        out += ",";
      }
      i += 1;
      continue;
    }
    if (c === "}") {
      if (braceDepth === 0) return null;
      braceDepth -= 1;
      out += ")";
      i += 1;
      continue;
    }
    out += escapeChar(c);
    i += 1;
  }
  if (braceDepth !== 0) return null;

  try {
    return new RegExp(`^${out}$`);
  } catch {
    return null;
  }
}
