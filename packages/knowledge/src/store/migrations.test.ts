import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations, CURRENT_SCHEMA_VERSION } from "./migrations.js";

function tablesIn(db: Database.Database): Set<string> {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'",
    )
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

describe("migrations", () => {
  it("creates all expected tables on a fresh DB", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const tables = tablesIn(db);
    for (const expected of [
      "schema_version",
      "documents",
      "chunks",
      "chunks_fts",
      "chunk_fts_map",
      "entities",
      "aliases",
      "entity_mentions",
      "edges",
      "embeddings",
      "ingest_runs",
      "llm_annotations",
      "review_overrides",
      "voice_evidence_strata",
      "voice_profile_candidates",
      "voice_profiles",
      "voice_profiles_history",
      "voice_eval_runs",
      "self_models",
    ]) {
      expect(tables.has(expected)).toBe(true);
    }
    db.close();
  });

  it("records the current schema version as the highest applied", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const row = db
      .prepare("SELECT MAX(version) AS v FROM schema_version")
      .get() as { v: number };
    expect(row.v).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it("is idempotent — re-applying does not duplicate version rows", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    applyMigrations(db);
    const rows = db
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as Array<{ version: number }>;
    // Each migrated version is recorded once; re-apply must not duplicate.
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    db.close();
  });

  it("v9 — indexes entity_mentions(chunk_id)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_mentions_chunk'",
      )
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe("idx_mentions_chunk");
    db.close();
  });

  it("enforces foreign keys", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    expect(() => {
      db.prepare(
        "INSERT INTO chunks (id, document_id, ordinal, section_path, text, text_hash, token_estimate) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("c1", "doc-does-not-exist", 0, "[]", "x", "h", 1);
    }).toThrow(/FOREIGN KEY/i);
    db.close();
  });
});

describe("migrations v2 — claims table", () => {
  it("creates claims table at version 2 with required columns", () => {
    const db = new Database(":memory:");
    applyMigrations(db);

    // Verify table exists and has the expected columns
    const cols = db.prepare("PRAGMA table_info(claims)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "id",
        "subject_entity_id",
        "predicate",
        "object_entity_id",
        "value",
        "qualifiers_json",
        "evidence_chunk_ids_json",
        "confidence",
        "method",
        "status",
        "rationale",
        "created_at",
        "supersedes_claim_id",
      ].sort(),
    );

    // Verify version 2 was recorded
    const version2Row = db
      .prepare("SELECT version FROM schema_version WHERE version = 2")
      .get() as { version: number } | undefined;
    expect(version2Row).toBeDefined();
    db.close();
  });

  it("upgrades an existing v1-only DB to v2 without dropping data", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      "INSERT INTO entities (id, type, canonical_name) VALUES (?, ?, ?)",
    ).run("herta.person.prime", "person", "黑塔");
    // Re-apply (acts like an upgrade path: no destructive ops).
    applyMigrations(db);
    const ent = db
      .prepare("SELECT id FROM entities WHERE id = ?")
      .get("herta.person.prime") as { id: string } | undefined;
    expect(ent).toBeDefined();
    db.close();
  });
});

describe("migrations v3 — wiki_pages table", () => {
  it("creates wiki_pages table at version 3 with required columns", () => {
    const db = new Database(":memory:");
    applyMigrations(db);

    const cols = db.prepare("PRAGMA table_info(wiki_pages)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "entity_id",
        "generated_at",
        "content_json",
        "claim_ids_json",
        "source_chunk_ids_json",
      ].sort(),
    );

    const versionRow = db
      .prepare("SELECT version FROM schema_version WHERE version = 3")
      .get() as { version: number } | undefined;
    expect(versionRow).toBeDefined();
    db.close();
  });

  it("re-applying migrations records each version once", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    applyMigrations(db);
    const rows = db
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as Array<{ version: number }>;
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    db.close();
  });
});

describe("migrations v4 — voice profile tables", () => {
  it("bumps CURRENT_SCHEMA_VERSION to 9", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(9);
  });

  it("creates voice_evidence_strata at version 4 with required columns", () => {
    const db = new Database(":memory:");
    applyMigrations(db);

    const cols = db
      .prepare("PRAGMA table_info(voice_evidence_strata)")
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "chunk_id",
        "speaker_entity_id",
        "addressee_class",
        "addressee_entity_id",
        "classifier_version",
        "classified_at",
        "addressee_entity_id_llm",
        "mood",
        "register_mode",
        "grounded_citation",
        "confidence",
        "source",
        "disagreement_with_heuristic",
        "pass_a_verdict_json",
        "pass_b_verdict_json",
      ].sort(),
    );

    const versionRow = db
      .prepare("SELECT MAX(version) AS v FROM schema_version")
      .get() as { v: number };
    expect(versionRow.v).toBe(9);
    db.close();
  });

  it("creates voice_profile_candidates with required columns", () => {
    const db = new Database(":memory:");
    applyMigrations(db);

    const cols = db
      .prepare("PRAGMA table_info(voice_profile_candidates)")
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "id",
        "entity_id",
        "register_class",
        "round",
        "candidate_json",
        "source_chunk_ids_json",
        "prompt_hash",
        "generated_at",
        "pass_run",
        "consensus",
      ].sort(),
    );
    db.close();
  });

  it("creates voice_profiles with required columns (including v5 self_narration_json and v6 evidence_strata_version)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);

    const cols = db
      .prepare("PRAGMA table_info(voice_profiles)")
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "entity_id",
        "schema_version",
        "default_register_json",
        "relationship_registers_json",
        "self_narration_json",
        "anti_patterns_json",
        "evidence_chunk_ids_json",
        "generated_at",
        "source_round",
        "evidence_strata_version",
      ].sort(),
    );
    db.close();
  });

  it("creates expected indexes on the v4 tables", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;
    const names = new Set(indexes.map((i) => i.name));
    expect(names.has("idx_strata_speaker_addressee")).toBe(true);
    expect(names.has("idx_candidates_entity_register_round")).toBe(true);
    db.close();
  });

  it("upgrades an existing v3 DB to v4 without dropping data", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      "INSERT INTO entities (id, type, canonical_name) VALUES (?, ?, ?)",
    ).run("herta.person.prime", "person", "黑塔");
    db.prepare(
      `INSERT INTO wiki_pages (entity_id, generated_at, content_json, claim_ids_json, source_chunk_ids_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("herta.person.prime", "2026-05-08T00:00:00.000Z", "{}", "[]", "[]");

    // Re-apply (acts like an upgrade path: no destructive ops).
    applyMigrations(db);

    const ent = db
      .prepare("SELECT id FROM entities WHERE id = ?")
      .get("herta.person.prime") as { id: string } | undefined;
    expect(ent).toBeDefined();
    const wiki = db
      .prepare("SELECT entity_id FROM wiki_pages WHERE entity_id = ?")
      .get("herta.person.prime") as { entity_id: string } | undefined;
    expect(wiki).toBeDefined();
    db.close();
  });
});

describe("migrations v5 — voice_profiles.self_narration_json column", () => {
  it("adds self_narration_json column to voice_profiles", () => {
    const db = new Database(":memory:");
    applyMigrations(db);

    const cols = db
      .prepare("PRAGMA table_info(voice_profiles)")
      .all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const selfNarr = cols.find((c) => c.name === "self_narration_json");
    expect(selfNarr).toBeDefined();
    if (selfNarr === undefined) return;
    expect(selfNarr.type).toBe("TEXT");
    expect(selfNarr.notnull).toBe(1);
    db.close();
  });

  it("records version 5 in schema_version", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const row = db
      .prepare("SELECT version FROM schema_version WHERE version = 5")
      .get() as { version: number } | undefined;
    expect(row).toBeDefined();
    db.close();
  });

  it("is idempotent — re-applying does not duplicate the column", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    // Re-apply should not throw "duplicate column" — the v5 step guards on
    // PRAGMA table_info before issuing ALTER TABLE.
    expect(() => applyMigrations(db)).not.toThrow();
    const cols = db
      .prepare("PRAGMA table_info(voice_profiles)")
      .all() as Array<{ name: string }>;
    const matches = cols.filter((c) => c.name === "self_narration_json");
    expect(matches).toHaveLength(1);
    db.close();
  });
});

describe("v6 migration", () => {
  it("adds new columns to voice_evidence_strata", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info(voice_evidence_strata)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "addressee_entity_id_llm",
        "mood",
        "register_mode",
        "grounded_citation",
        "confidence",
        "source",
        "disagreement_with_heuristic",
        "pass_a_verdict_json",
        "pass_b_verdict_json",
      ]),
    );
    db.close();
  });

  it("adds pass_run and consensus columns to voice_profile_candidates", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info(voice_profile_candidates)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["pass_run", "consensus"]));
    db.close();
  });

  it("creates voice_profiles_history table mirroring voice_profiles + archived_at", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info(voice_profiles_history)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "entity_id",
        "schema_version",
        "default_register_json",
        "relationship_registers_json",
        "anti_patterns_json",
        "evidence_chunk_ids_json",
        "self_narration_json",
        "generated_at",
        "source_round",
        "evidence_strata_version",
        "archived_at",
      ]),
    );
    db.close();
  });

  it("creates voice_eval_runs table", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info(voice_eval_runs)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "id",
        "eval_set_version",
        "voice_profiles_evidence_strata_version",
        "prompt_index",
        "prompt_text",
        "assistant_text",
        "validated_phrases_present_json",
        "anti_patterns_present_json",
        "code_switch_count",
        "ran_at",
      ]),
    );
    db.close();
  });

  it("is idempotent across re-applies", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();
    const versions = db
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as Array<{ version: number }>;
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    db.close();
  });
});

describe("v7 migration — self_models table", () => {
  it("creates self_models table with required columns", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(self_models)").all() as Array<{
      name: string;
    }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "id",
        "entity_id",
        "schema_version",
        "payload_json",
        "judge_report_json",
        "source_facts_hash",
        "shipped_at",
      ].sort(),
    );
    db.close();
  });

  it("creates idx_self_models_entity_shipped index", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_self_models_entity_shipped'",
      )
      .get() as { name: string } | undefined;
    expect(idx).toBeDefined();
    db.close();
  });

  it("self_models.entity_id enforces FK to entities", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    expect(() => {
      db.prepare(
        `INSERT INTO self_models (entity_id, schema_version, payload_json, shipped_at)
         VALUES (?, ?, ?, ?)`,
      ).run("ghost.entity", 1, "{}", "2026-05-11T00:00:00.000Z");
    }).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it("allows multiple ships per entity (history)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      "INSERT INTO entities (id, type, canonical_name) VALUES (?, ?, ?)",
    ).run("herta.person.prime", "person", "黑塔");
    const insert = db.prepare(
      `INSERT INTO self_models (entity_id, schema_version, payload_json, shipped_at)
       VALUES (?, ?, ?, ?)`,
    );
    insert.run("herta.person.prime", 1, '{"v":1}', "2026-05-10T00:00:00.000Z");
    insert.run("herta.person.prime", 1, '{"v":2}', "2026-05-11T00:00:00.000Z");
    const rows = db
      .prepare(
        "SELECT shipped_at FROM self_models WHERE entity_id = ? ORDER BY shipped_at DESC",
      )
      .all("herta.person.prime") as Array<{ shipped_at: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.shipped_at).toBe("2026-05-11T00:00:00.000Z");
    db.close();
  });

  it("is idempotent across re-applies", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();
    const cols = db.prepare("PRAGMA table_info(self_models)").all() as Array<{
      name: string;
    }>;
    expect(cols.length).toBe(7);
    db.close();
  });
});

describe("v8 migration — chunk_translations table", () => {
  it("creates chunk_translations with the (chunk_id, lang) primary key", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info(chunk_translations)")
      .all() as Array<{ name: string; pk: number }>;
    expect(cols.map((c) => c.name).sort()).toEqual(
      [
        "chunk_id",
        "lang",
        "text",
        "textmap_hash",
        "match_kind",
        "aligned_at",
      ].sort(),
    );
    const pk = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pk).toEqual(["chunk_id", "lang"]);
    db.close();
  });

  it("records version 8 and stays idempotent", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();
    const row = db
      .prepare("SELECT version FROM schema_version WHERE version = 8")
      .get() as { version: number } | undefined;
    expect(row?.version).toBe(8);
    db.close();
  });

  it("one row per (chunk, lang): a second upsert replaces, a second lang coexists", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      "INSERT INTO entities (id, type, canonical_name) VALUES (?, ?, ?)",
    ).run("herta.person.prime", "person", "黑塔");
    db.prepare(
      `INSERT INTO documents (id, kind, title, path, source_hash, created_at)
       VALUES ('d1', 'mission_dialogue', 't', 'p', 'h', '2026-07-14')`,
    ).run();
    db.prepare(
      `INSERT INTO chunks (id, document_id, ordinal, section_path, text,
         text_hash, token_estimate)
       VALUES ('c1', 'd1', 0, '["root"]', 'x', 'th', 1)`,
    ).run();
    const ins = db.prepare(
      `INSERT INTO chunk_translations (chunk_id, lang, text, textmap_hash, match_kind, aligned_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chunk_id, lang) DO UPDATE SET text = excluded.text`,
    );
    ins.run("c1", "en", "one", "h1", "exact", "2026-07-14");
    ins.run("c1", "en", "two", "h1", "exact", "2026-07-14");
    ins.run("c1", "jp", "三", "h1", "exact", "2026-07-14");
    const rows = db
      .prepare(
        "SELECT lang, text FROM chunk_translations WHERE chunk_id = 'c1' ORDER BY lang",
      )
      .all() as Array<{ lang: string; text: string }>;
    expect(rows).toEqual([
      { lang: "en", text: "two" },
      { lang: "jp", text: "三" },
    ]);
    db.close();
  });
});
