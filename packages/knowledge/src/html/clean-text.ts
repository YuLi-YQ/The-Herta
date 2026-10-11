// Boilerplate patterns. Expected to grow as Task 9 fixtures expose more wiki cruft.
// Anchor patterns to full-string match (or to a clear leading sentence stem) so we
// don't accidentally drop canon lines that happen to start with a nav-word stem
// (e.g. "目录学：…", "导航员的故事").
const BOILERPLATE_PATTERNS: ReadonlyArray<RegExp> = [
  /^如果是第一次来/,
  /著作权归原作者所有/,
  /^((编辑|查看源代码|历史|讨论|目录|刷新)\s*)+$/,
  /^导航\s*$/,
  /^最近更改\s*$/,
  /^Copyright\b/i,
];

export function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function isBoilerplate(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.length === 0) return true;
  for (const re of BOILERPLATE_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  return false;
}
