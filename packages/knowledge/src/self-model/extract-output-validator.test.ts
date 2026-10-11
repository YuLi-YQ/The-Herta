import { describe, expect, it } from "vitest";
import { parseExtractionOutput } from "./extract-output-validator.js";

const VALID_JSON = JSON.stringify({
  source: "019_大黑塔.html",
  facts: [
    {
      kind: "biography",
      prose: "She is Genius Society member #83.",
      evidence_excerpt: "天才俱乐部 #83",
      confidence: "high",
    },
  ],
});

describe("parseExtractionOutput", () => {
  it("returns ok with parsed file-facts on valid JSON", () => {
    const r = parseExtractionOutput(VALID_JSON, {
      expectedSource: "019_大黑塔.html",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fileFacts.source).toBe("019_大黑塔.html");
      expect(r.fileFacts.facts).toHaveLength(1);
      expect(r.fileFacts.facts[0]?.kind).toBe("biography");
    }
  });

  it("returns error when input is not JSON", () => {
    const r = parseExtractionOutput("this is not JSON", {
      expectedSource: "x.html",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_json");
      expect(r.message).toContain("JSON");
    }
  });

  it("returns error when schema validation fails (missing facts)", () => {
    const bad = JSON.stringify({ source: "x.html" });
    const r = parseExtractionOutput(bad, { expectedSource: "x.html" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("schema_invalid");
    }
  });

  it("returns error when schema validation fails (unknown kind)", () => {
    const bad = JSON.stringify({
      source: "x.html",
      facts: [
        {
          kind: "junk",
          prose: "x",
          evidence_excerpt: "y",
          confidence: "high",
        },
      ],
    });
    const r = parseExtractionOutput(bad, { expectedSource: "x.html" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("schema_invalid");
    }
  });

  it("returns error when source field does not match expected", () => {
    const r = parseExtractionOutput(VALID_JSON, {
      expectedSource: "different.html",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("source_mismatch");
    }
  });

  it("strips a leading markdown fence if present (best-effort recovery)", () => {
    const wrapped = `\`\`\`json\n${VALID_JSON}\n\`\`\``;
    const r = parseExtractionOutput(wrapped, {
      expectedSource: "019_大黑塔.html",
    });
    expect(r.ok).toBe(true);
  });

  it("strips an unfenced ```json prefix without closing fence", () => {
    const wrapped = `\`\`\`json\n${VALID_JSON}`;
    const r = parseExtractionOutput(wrapped, {
      expectedSource: "019_大黑塔.html",
    });
    expect(r.ok).toBe(true);
  });

  it("accepts an empty facts array (irrelevant document case)", () => {
    const empty = JSON.stringify({ source: "incidental.html", facts: [] });
    const r = parseExtractionOutput(empty, {
      expectedSource: "incidental.html",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fileFacts.facts).toEqual([]);
  });

  it("flags evidence_excerpt that is not a substring of the source as a coercion warning", () => {
    const fabricated = JSON.stringify({
      source: "x.html",
      facts: [
        {
          kind: "biography",
          prose: "fake fact",
          evidence_excerpt: "this exact string is not in the source",
          confidence: "high",
        },
      ],
    });
    const r = parseExtractionOutput(fabricated, {
      expectedSource: "x.html",
      sourceText: "the actual source text contains other things entirely",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings).toContainEqual(
        expect.objectContaining({ kind: "ungrounded_evidence" }),
      );
    }
  });

  it("does not warn when evidence_excerpt is a substring of source", () => {
    const valid = JSON.stringify({
      source: "x.html",
      facts: [
        {
          kind: "biography",
          prose: "x",
          evidence_excerpt: "天才俱乐部 #83",
          confidence: "high",
        },
      ],
    });
    const r = parseExtractionOutput(valid, {
      expectedSource: "x.html",
      sourceText: "她是天才俱乐部 #83 的成员。",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings).toEqual([]);
    }
  });

  it("warnings are silently empty when sourceText is not provided", () => {
    const valid = JSON.stringify({
      source: "x.html",
      facts: [
        {
          kind: "biography",
          prose: "x",
          evidence_excerpt: "anything",
          confidence: "high",
        },
      ],
    });
    const r = parseExtractionOutput(valid, { expectedSource: "x.html" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings).toEqual([]);
    }
  });
});
