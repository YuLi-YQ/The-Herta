import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMentionOverrides } from "./override-loader.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herta-overrides-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadMentionOverrides", () => {
  it("returns empty array when overrides.jsonl does not exist", async () => {
    const out = await loadMentionOverrides(dir);
    expect(out).toEqual([]);
  });

  it("parses a valid mention-override record", async () => {
    writeFileSync(
      join(dir, "overrides.jsonl"),
      `${JSON.stringify({
        target_type: "mention",
        chunk_id: "doc:abc#0",
        surface: "黑塔",
        referent_entity_id: "herta.person.prime",
        embodiment_entity_id: "herta.form.doll",
        confidence: 1.0,
        note: "test",
      })}\n`,
      "utf8",
    );
    const out = await loadMentionOverrides(dir);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      chunkId: "doc:abc#0",
      surface: "黑塔",
      referentEntityId: "herta.person.prime",
      embodimentEntityId: "herta.form.doll",
      confidence: 1.0,
      note: "test",
    });
  });

  it("skips malformed lines and returns the valid ones", async () => {
    const lines = [
      "not json at all",
      JSON.stringify({
        target_type: "mention",
        chunk_id: "c1",
        surface: "黑塔",
        referent_entity_id: "herta.person.prime",
        confidence: 1.0,
      }),
      JSON.stringify({ target_type: "mention" }),
      JSON.stringify({
        target_type: "mention",
        chunk_id: "c2",
        surface: "黑塔",
        referent_entity_id: "herta.form.doll",
        confidence: 0.95,
      }),
    ];
    writeFileSync(
      join(dir, "overrides.jsonl"),
      `${lines.join("\n")}\n`,
      "utf8",
    );
    const out = await loadMentionOverrides(dir);
    expect(out.map((o) => o.chunkId)).toEqual(["c1", "c2"]);
  });

  it("skips records with target_type other than 'mention'", async () => {
    writeFileSync(
      join(dir, "overrides.jsonl"),
      `${JSON.stringify({
        target_type: "entity",
        chunk_id: "c1",
        surface: "黑塔",
        referent_entity_id: "herta.person.prime",
        confidence: 1.0,
      })}\n`,
      "utf8",
    );
    const out = await loadMentionOverrides(dir);
    expect(out).toEqual([]);
  });

  it("ignores blank lines", async () => {
    writeFileSync(
      join(dir, "overrides.jsonl"),
      `\n\n${JSON.stringify({
        target_type: "mention",
        chunk_id: "c1",
        surface: "黑塔",
        referent_entity_id: "herta.person.prime",
        confidence: 1.0,
      })}\n\n`,
      "utf8",
    );
    const out = await loadMentionOverrides(dir);
    expect(out).toHaveLength(1);
  });
});
