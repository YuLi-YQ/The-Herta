import { describe, expect, it } from "vitest";
import { buildClaimExtractionRequest } from "./claim-extraction-prompt.js";

describe("buildClaimExtractionRequest", () => {
  it("returns a DisambiguationBatchInput-shaped object with stable JSON", () => {
    const a = buildClaimExtractionRequest({
      model: "deepseek-chat",
      knownEntityIds: ["herta.person.prime", "faction.genius_society"],
      knownPredicates: ["member_number", "member_of"],
      chunks: [
        {
          chunkId: "chunk:1",
          documentTitle: "黑塔",
          documentKind: "character_profile",
          sectionPath: ["简介"],
          text: "黑塔是天才俱乐部#83。",
          mentions: [
            {
              surface: "黑塔",
              referentEntityId: "herta.person.prime",
            },
          ],
        },
      ],
    });
    expect(a.model).toBe("deepseek-chat");
    expect(typeof a.systemPrompt).toBe("string");
    expect(a.systemPrompt.length).toBeGreaterThan(0);
    const userObj = JSON.parse(a.userPayload) as {
      task: string;
      chunks: unknown[];
    };
    expect(userObj.task).toBe("extract_canon_claims");
    expect(userObj.chunks).toHaveLength(1);
  });

  it("produces byte-identical output for byte-identical input (cache friendliness)", () => {
    const args = {
      model: "deepseek-chat",
      knownEntityIds: ["herta.person.prime"],
      knownPredicates: ["member_number"],
      chunks: [
        {
          chunkId: "chunk:1",
          documentTitle: "黑塔",
          documentKind: "character_profile" as const,
          sectionPath: ["简介"],
          text: "...",
          mentions: [],
        },
      ],
    };
    const a = buildClaimExtractionRequest(args);
    const b = buildClaimExtractionRequest(args);
    expect(a.userPayload).toBe(b.userPayload);
    expect(a.systemPrompt).toBe(b.systemPrompt);
  });

  it("system prompt names the known predicates and refuses inventing facts", () => {
    const a = buildClaimExtractionRequest({
      model: "deepseek-chat",
      knownEntityIds: ["herta.person.prime"],
      knownPredicates: ["member_number", "owns"],
      chunks: [],
    });
    expect(a.systemPrompt).toMatch(/Do not invent/i);
    expect(a.systemPrompt).toMatch(/known predicates/i);
  });

  it("emits a predicate_definitions map alongside known_predicates", () => {
    const a = buildClaimExtractionRequest({
      model: "deepseek-chat",
      knownEntityIds: ["herta.person.prime"],
      knownPredicates: ["member_of", "member_number", "owns"],
      predicateDefinitions: {
        member_of: "subject is a member of the object (an organization).",
        member_number:
          "subject's identifier within an organization (literal string value, e.g. '#83').",
        owns: "subject owns the object.",
      },
      chunks: [],
    });
    const userObj = JSON.parse(a.userPayload) as {
      predicate_definitions?: Record<string, string>;
    };
    expect(userObj.predicate_definitions).toBeDefined();
    expect(userObj.predicate_definitions?.member_of).toMatch(/member of/i);
    expect(userObj.predicate_definitions?.owns).toMatch(/owns/);
  });

  it("omits predicate_definitions when the option is undefined (back-compat)", () => {
    const a = buildClaimExtractionRequest({
      model: "deepseek-chat",
      knownEntityIds: ["herta.person.prime"],
      knownPredicates: ["member_of"],
      chunks: [],
    });
    const userObj = JSON.parse(a.userPayload) as {
      predicate_definitions?: Record<string, string>;
    };
    expect(userObj.predicate_definitions).toBeUndefined();
  });
});
