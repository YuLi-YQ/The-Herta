import { describe, expect, it } from "vitest";
import {
  buildDisambiguationRequest,
  DISAMBIGUATION_SYSTEM_PROMPT,
} from "./disambiguation-prompt.js";

describe("DISAMBIGUATION_SYSTEM_PROMPT", () => {
  it("contains the literal word 'json' (required by DeepSeek JSON mode)", () => {
    expect(DISAMBIGUATION_SYSTEM_PROMPT.toLowerCase()).toContain("json");
  });

  it("is stable across calls (same value, no time/randomness)", () => {
    const a = DISAMBIGUATION_SYSTEM_PROMPT;
    const b = DISAMBIGUATION_SYSTEM_PROMPT;
    expect(a).toBe(b);
  });

  it("instructs the model not to invent facts", () => {
    expect(DISAMBIGUATION_SYSTEM_PROMPT.toLowerCase()).toMatch(/do not invent/);
  });
});

describe("buildDisambiguationRequest", () => {
  it("returns a request whose userPayload contains the chunks verbatim", () => {
    const req = buildDisambiguationRequest({
      model: "deepseek-chat",
      chunks: [
        {
          chunkId: "c1",
          documentTitle: "天才群星闪耀时",
          documentKind: "mission_dialogue",
          sectionPath: ["剧情内容", "与黑塔交谈"],
          speaker: "黑塔",
          text: "本人远程操纵此处的人偶。",
        },
      ],
    });
    expect(req.model).toBe("deepseek-chat");
    expect(req.systemPrompt).toBe(DISAMBIGUATION_SYSTEM_PROMPT);
    const user = JSON.parse(req.userPayload) as {
      task: string;
      entity_definitions: Record<string, string>;
      chunks: Array<{ chunk_id: string; speaker?: string; text: string }>;
    };
    expect(user.task).toBe("disambiguate_herta_mentions");
    expect(user.entity_definitions["herta.person.prime"]).toContain(
      "Genius Society",
    );
    expect(user.chunks).toHaveLength(1);
    expect(user.chunks[0]?.chunk_id).toBe("c1");
    expect(user.chunks[0]?.speaker).toBe("黑塔");
    expect(user.chunks[0]?.text).toBe("本人远程操纵此处的人偶。");
  });

  it("includes a json_schema_example field that names the 5 Herta entity IDs", () => {
    const req = buildDisambiguationRequest({
      model: "deepseek-chat",
      chunks: [],
    });
    const user = JSON.parse(req.userPayload) as {
      required_json_schema_example: unknown;
      entity_definitions: Record<string, string>;
    };
    expect(user.required_json_schema_example).toBeDefined();
    expect(user.entity_definitions).toHaveProperty("herta.person.prime");
    expect(user.entity_definitions).toHaveProperty("herta.form.doll");
    expect(user.entity_definitions).toHaveProperty("herta.place.space_station");
    expect(user.entity_definitions).toHaveProperty("herta.work.manuscript");
    expect(user.entity_definitions).toHaveProperty("herta.name.ambiguous");
  });

  it("produces deterministic output for identical input (cache-friendly)", () => {
    const input = {
      model: "deepseek-chat",
      chunks: [
        {
          chunkId: "c1",
          documentTitle: "T",
          documentKind: "world_lore" as const,
          sectionPath: [],
          text: "x",
        },
      ],
    };
    const a = buildDisambiguationRequest(input);
    const b = buildDisambiguationRequest(input);
    expect(a.systemPrompt).toBe(b.systemPrompt);
    expect(a.userPayload).toBe(b.userPayload);
  });
});
