import { describe, expect, it } from "vitest";
import {
  corpusManifestSchema,
  factItemSchema,
  hertaFactsSchema,
  hertaSelfModelV1Schema,
  judgeReportSchema,
} from "./schema.js";

describe("self-model schemas", () => {
  describe("corpusManifestSchema", () => {
    it("parses a minimal valid manifest", () => {
      const valid = {
        version: 1,
        candidates: [
          {
            path: "data/角色图鉴/019_大黑塔.html",
            mention_count: 142,
            snippet_previews: ["...大黑塔..."],
            accepted: true,
            category: "character_page",
          },
        ],
      };
      const parsed = corpusManifestSchema.parse(valid);
      expect(parsed.candidates).toHaveLength(1);
      expect(parsed.candidates[0]?.accepted).toBe(true);
    });

    it("rejects unknown category values", () => {
      const invalid = {
        version: 1,
        candidates: [
          {
            path: "x.html",
            mention_count: 1,
            snippet_previews: [],
            accepted: false,
            category: "junk",
          },
        ],
      };
      expect(() => corpusManifestSchema.parse(invalid)).toThrow();
    });

    it("rejects negative mention_count", () => {
      const invalid = {
        version: 1,
        candidates: [
          {
            path: "x.html",
            mention_count: -1,
            snippet_previews: [],
            accepted: false,
            category: "character_page",
          },
        ],
      };
      expect(() => corpusManifestSchema.parse(invalid)).toThrow();
    });
  });

  describe("factItemSchema", () => {
    it("parses a fact with all kinds", () => {
      for (const kind of [
        "biography",
        "philosophy",
        "embodiment",
        "relationship",
        "harness_proprioception",
        "anti_pattern",
        "interaction_register",
      ] as const) {
        const valid = {
          kind,
          prose: "atomic fact",
          evidence_excerpt: "verbatim quote",
          confidence: "high" as const,
        };
        expect(() => factItemSchema.parse(valid)).not.toThrow();
      }
    });

    it("rejects unknown kind", () => {
      expect(() =>
        factItemSchema.parse({
          kind: "junk",
          prose: "x",
          evidence_excerpt: "y",
          confidence: "high",
        }),
      ).toThrow();
    });

    it("rejects unknown confidence", () => {
      expect(() =>
        factItemSchema.parse({
          kind: "biography",
          prose: "x",
          evidence_excerpt: "y",
          confidence: "certain",
        }),
      ).toThrow();
    });
  });

  describe("hertaFactsSchema", () => {
    it("parses a valid facts file", () => {
      const valid = {
        version: 1,
        generated_at: "2026-05-10T14:20:00Z",
        provenance: {
          passes: [{ name: "fact-extract", model: "deepseek-v4-pro" }],
        },
        files: [
          {
            source: "019_大黑塔.html",
            facts: [
              {
                kind: "biography",
                prose: "...",
                evidence_excerpt: "...",
                confidence: "high",
              },
            ],
          },
        ],
        failures: [],
      };
      expect(() => hertaFactsSchema.parse(valid)).not.toThrow();
    });
  });

  describe("hertaSelfModelV1Schema", () => {
    it("parses a valid self-model with all required slots", () => {
      const valid = {
        version: 1,
        generated_at: "2026-05-10T14:20:00Z",
        provenance: {
          passes: [
            { name: "fact-extract", model: "deepseek-v4-pro" },
            { name: "synthesize", model: "deepseek-v4-pro" },
          ],
        },
        biography: { prose: "I am...", key_facts: [] },
        philosophy: { prose: "I value...", key_facts: [] },
        embodiment: { prose: "My workshop...", key_facts: [] },
        relationships: {},
        harness_proprioception: { prose: "This terminal...", key_facts: [] },
        anti_patterns: [],
        interaction_register: { prose: "I sound...", samples: [] },
      };
      expect(() => hertaSelfModelV1Schema.parse(valid)).not.toThrow();
    });

    it("rejects when a required slot is missing", () => {
      const invalid = {
        version: 1,
        generated_at: "2026-05-10T14:20:00Z",
        provenance: { passes: [] },
        biography: { prose: "I am...", key_facts: [] },
        // missing philosophy, embodiment, etc.
      };
      expect(() => hertaSelfModelV1Schema.parse(invalid)).toThrow();
    });
  });

  describe("judgeReportSchema", () => {
    it("parses a valid judge report with scores 0-5", () => {
      const valid = {
        version: 1,
        judged_at: "2026-05-10T14:20:00Z",
        model: "deepseek-v4-pro",
        scores: {
          biography: {
            in_voice: 4,
            canon_grounded: 5,
            coherent: 5,
            no_leakage: 4,
            concerns: [],
          },
        },
      };
      expect(() => judgeReportSchema.parse(valid)).not.toThrow();
    });

    it("rejects scores outside 0-5", () => {
      const invalid = {
        version: 1,
        judged_at: "2026-05-10T14:20:00Z",
        model: "deepseek-v4-pro",
        scores: {
          biography: {
            in_voice: 6,
            canon_grounded: 5,
            coherent: 5,
            no_leakage: 4,
            concerns: [],
          },
        },
      };
      expect(() => judgeReportSchema.parse(invalid)).toThrow();
    });
  });
});
