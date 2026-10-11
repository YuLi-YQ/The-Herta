import type { SystemBlock, TerminalRecord } from "@herta/core";
import { describe, expect, it } from "vitest";
import { serializeTerminalRecord } from "./serialize.js";

describe("compaction-format snapshot", () => {
  it("serializes a compaction-summary system block in SPEC §10 shape", () => {
    const compaction: SystemBlock = {
      kind: "system",
      label: "系统",
      body: [
        "compacted prior work:",
        "- 开拓者 asked to fix the parser cursor bug",
        "- 我 said the bug was reproducible in the targeted test",
        "- 差分协处理器 patched packages/core/src/parser.ts",
        "- Diff: cursor reset on tag-close; +12 / -3 lines",
        "- Tests: targeted suite passes (12/12)",
        "- Remaining risk: full suite not yet run",
      ].join("\n"),
    };

    const record: TerminalRecord = [compaction];
    const serialized = serializeTerminalRecord(record);

    expect(serialized).toMatchInlineSnapshot(`
"→ 系统

\`\`\`text
compacted prior work:
- 开拓者 asked to fix the parser cursor bug
- 我 said the bug was reproducible in the targeted test
- 差分协处理器 patched packages/core/src/parser.ts
- Diff: cursor reset on tag-close; +12 / -3 lines
- Tests: targeted suite passes (12/12)
- Remaining risk: full suite not yet run
\`\`\`"
`);
  });

  it("a long compaction body with embedded diffs still serializes cleanly", () => {
    const compaction: SystemBlock = {
      kind: "system",
      label: "系统",
      body: [
        "compacted prior work:",
        "",
        "Diff applied to packages/core/src/parser.ts:",
        "```diff",
        "-cursor = 0",
        "+cursor = tagStart",
        "```",
        "",
        "Tests: 12/12 in targeted suite.",
      ].join("\n"),
    };

    const serialized = serializeTerminalRecord([compaction]);
    expect(serialized).toMatch(/^→ 系统\n\n````+text\n/);
    expect(serialized).toContain(
      "```diff\n-cursor = 0\n+cursor = tagStart\n```",
    );
  });
});
