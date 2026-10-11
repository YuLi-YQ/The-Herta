import { describe, expect, it } from "vitest";
import * as core from "../index.js";

describe("@herta/core v0.2 type exports", () => {
  it("exports SYSTEM_BLOCK_LABELS constant", () => {
    expect(core.SYSTEM_BLOCK_LABELS).toEqual(["系统", "差分协处理器"]);
  });

  it("exports isSystemBlockLabel runtime guard", () => {
    expect(core.isSystemBlockLabel("系统")).toBe(true);
    expect(core.isSystemBlockLabel("板砖")).toBe(false);
  });

  it("no longer exports the retired v0.1 capsule/evidence runtime (ADR 0041)", () => {
    const keys = Object.keys(core);
    for (const gone of [
      "activate",
      "buildEvidence",
      "estimateTokens",
      "EMPTY_PROMPT_TRACE",
      "StubContextBuilder",
      "InMemoryEvidenceStore",
      "TerminalScrollback",
      "stripAnsi",
    ]) {
      expect(keys).not.toContain(gone);
    }
  });
});
