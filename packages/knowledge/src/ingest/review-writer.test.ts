import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HERTA_NAME_AMBIGUOUS } from "../schema.js";
import { ReviewWriter } from "./review-writer.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herta-review-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ReviewWriter", () => {
  it("writes low-confidence mentions to ambiguous-herta-mentions.jsonl", () => {
    const w = new ReviewWriter({ outDir: dir });
    w.recordAmbiguous({
      chunkId: "c1",
      path: "data/other/y.html",
      title: "无关标题",
      sectionPath: [],
      text: "黑塔出现了。",
      candidate: {
        surface: "黑塔",
        referentEntityId: HERTA_NAME_AMBIGUOUS,
        confidence: 0.55,
        rationale: "no signal",
      },
    });
    w.close();
    const file = join(dir, "ambiguous-herta-mentions.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0] ?? "{}");
    expect(entry.chunk_id).toBe("c1");
    expect(entry.candidate_mentions[0].referent_entity_id).toBe(
      HERTA_NAME_AMBIGUOUS,
    );
  });
});
