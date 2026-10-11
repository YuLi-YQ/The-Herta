import { describe, expect, it } from "vitest";
import {
  buildRestratifyPromptA,
  buildRestratifyPromptB,
  RESTRATIFY_OUTPUT_SCHEMA_VERSION,
} from "./restratify-llm-prompt.js";

describe("buildRestratifyPromptA", () => {
  it("includes the source HTML and chunks JSON", () => {
    const out = buildRestratifyPromptA({
      sourceHtml: "<html>scene</html>",
      hertaChunks: [
        { chunk_id: "c1", ordinal: 0, text: "你好" },
        { chunk_id: "c2", ordinal: 5, text: "再见" },
      ],
    });
    expect(out.systemPrompt).toMatch(/classify/i);
    expect(out.userPayload).toContain("<html>scene</html>");
    expect(out.userPayload).toContain('"chunk_id":"c1"');
    expect(out.userPayload).toContain('"chunk_id":"c2"');
  });

  it("differs in framing from prompt B", () => {
    const a = buildRestratifyPromptA({
      sourceHtml: "x",
      hertaChunks: [{ chunk_id: "c", ordinal: 0, text: "y" }],
    });
    const b = buildRestratifyPromptB({
      sourceHtml: "x",
      hertaChunks: [{ chunk_id: "c", ordinal: 0, text: "y" }],
    });
    expect(a.systemPrompt).not.toBe(b.systemPrompt);
  });

  it("declares output schema version", () => {
    expect(RESTRATIFY_OUTPUT_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });
});
