import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HERTA_PERSON_PRIME,
  VOICE_PROFILE_SCHEMA_VERSION,
  type VoiceEvidenceStratum,
  type VoiceProfile,
} from "../schema.js";
import {
  mkTempKnowledgeDb,
  type TempDb,
} from "../testing/mk-temp-knowledge-db.js";

describe("SqliteKnowledgeStore", () => {
  let h: TempDb;
  beforeEach(() => {
    h = mkTempKnowledgeDb();
  });
  afterEach(() => h.cleanup());

  it("seeds built-in entities on first open", () => {
    const e = h.store.getEntity(HERTA_PERSON_PRIME);
    expect(e?.canonicalName).toBe("大黑塔");
    const aliases = h.store.getAliases(HERTA_PERSON_PRIME).map((a) => a.alias);
    expect(aliases).toContain("黑塔本人");
  });

  it("inserts a document then a chunk and reads them back", () => {
    h.store.upsertDocument({
      id: "doc1",
      kind: "world_lore",
      title: "Test",
      path: "data/星海纪闻/test.html",
      sourceHash: "abc",
      createdAt: new Date().toISOString(),
    });
    h.store.insertChunk({
      id: "chunk1",
      documentId: "doc1",
      ordinal: 0,
      sectionPath: ["root"],
      text: "Hello 黑塔",
      textHash: "h1",
      tokenEstimate: 3,
      isDialogue: false,
      isHertaVoiceEvidence: false,
      isCanonFactCandidate: false,
      qualityScore: 0.5,
    });
    const c = h.store.getChunk("chunk1");
    expect(c?.text).toBe("Hello 黑塔");
  });

  it("upsertDocument is idempotent on (path, source_hash)", () => {
    const doc = {
      id: "doc-id-1",
      kind: "world_lore" as const,
      title: "T",
      path: "data/x.html",
      sourceHash: "h",
      createdAt: new Date().toISOString(),
    };
    h.store.upsertDocument(doc);
    h.store.upsertDocument(doc);
    const rows = h.store.rawAll<{ n: number }>(
      "SELECT count(*) AS n FROM documents WHERE path = ?",
      "data/x.html",
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("FTS index is populated when chunks are inserted", () => {
    h.store.upsertDocument({
      id: "doc1",
      kind: "world_lore",
      title: "Title",
      path: "data/星海纪闻/test.html",
      sourceHash: "abc",
      createdAt: new Date().toISOString(),
    });
    h.store.insertChunk({
      id: "c1",
      documentId: "doc1",
      ordinal: 0,
      sectionPath: ["root"],
      text: "黑塔本人 出现",
      textHash: "h1",
      tokenEstimate: 3,
      isDialogue: false,
      isHertaVoiceEvidence: false,
      isCanonFactCandidate: false,
      qualityScore: 0.5,
    });
    const matches = h.store.searchFts("黑塔本人", 10);
    expect(matches.some((m) => m.chunkId === "c1")).toBe(true);
  });

  it("searchFts never throws on FTS5 grammar in raw text (audit finding 23)", () => {
    h.store.upsertDocument({
      id: "doc1",
      kind: "world_lore",
      title: "Title",
      path: "data/星海纪闻/test.html",
      sourceHash: "abc",
      createdAt: new Date().toISOString(),
    });
    h.store.insertChunk({
      id: "c1",
      documentId: "doc1",
      ordinal: 0,
      sectionPath: ["root"],
      text: "黑塔本人 出现",
      textHash: "h1",
      tokenEstimate: 3,
      isDialogue: false,
      isHertaVoiceEvidence: false,
      isCanonFactCandidate: false,
      qualityScore: 0.5,
    });
    // Pre-fix each of these threw `SqliteError: fts5 syntax error` straight
    // out of the store (MATCH grammar injection — parameterization only
    // covers SQL, not the FTS5 query language).
    for (const hostile of [
      '她说"你好',
      "((unbalanced",
      "title:黑塔",
      "NEAR(",
      "*prefix",
      "   ",
      "",
    ]) {
      expect(() => h.store.searchFts(hostile, 10)).not.toThrow();
    }
    // Quoting must not break ordinary matching.
    expect(
      h.store.searchFts("黑塔本人", 10).some((m) => m.chunkId === "c1"),
    ).toBe(true);
  });

  it("upsertLlmAnnotation + getLlmAnnotation roundtrip", () => {
    h.store.upsertDocument({
      id: "doc1",
      kind: "world_lore",
      title: "T",
      path: "data/x.html",
      sourceHash: "h",
      createdAt: new Date().toISOString(),
    });
    h.store.insertChunk({
      id: "chunk-A",
      documentId: "doc1",
      ordinal: 0,
      sectionPath: ["root"],
      text: "test",
      textHash: "th",
      tokenEstimate: 1,
      isDialogue: false,
      isHertaVoiceEvidence: false,
      isCanonFactCandidate: false,
      qualityScore: 0,
    });
    h.store.upsertLlmAnnotation({
      id: "anno1",
      chunkId: "chunk-A",
      provider: "deepseek",
      model: "deepseek-chat",
      task: "disambiguate_herta_mentions",
      inputHash: "input-sha-1",
      outputJson: '{"chunks":[]}',
      confidence: 0.9,
      createdAt: new Date().toISOString(),
    });
    const row = h.store.getLlmAnnotation("input-sha-1");
    expect(row?.outputJson).toBe('{"chunks":[]}');
    expect(row?.model).toBe("deepseek-chat");
  });

  it("upsertLlmAnnotation is idempotent (INSERT OR IGNORE on input_hash)", () => {
    h.store.upsertDocument({
      id: "doc1",
      kind: "world_lore",
      title: "T",
      path: "data/x.html",
      sourceHash: "h",
      createdAt: new Date().toISOString(),
    });
    h.store.insertChunk({
      id: "chunk-B",
      documentId: "doc1",
      ordinal: 0,
      sectionPath: [],
      text: "test",
      textHash: "th",
      tokenEstimate: 1,
      isDialogue: false,
      isHertaVoiceEvidence: false,
      isCanonFactCandidate: false,
      qualityScore: 0,
    });
    const annot = {
      id: "anno-1",
      chunkId: "chunk-B",
      provider: "deepseek",
      model: "deepseek-chat",
      task: "disambiguate_herta_mentions",
      inputHash: "shared-input-hash",
      outputJson: '{"chunks":[{"x":1}]}',
      confidence: 0.9,
      createdAt: new Date().toISOString(),
    };
    h.store.upsertLlmAnnotation(annot);
    h.store.upsertLlmAnnotation({
      ...annot,
      id: "anno-2",
      outputJson: '{"chunks":[{"x":2}]}',
    });
    const rows = h.store.rawAll<{ n: number }>(
      "SELECT count(*) AS n FROM llm_annotations WHERE input_hash = ?",
      "shared-input-hash",
    );
    expect(rows[0]?.n).toBe(1);
    const cached = h.store.getLlmAnnotation("shared-input-hash");
    expect(cached?.outputJson).toBe('{"chunks":[{"x":1}]}'); // first wins
  });

  it("getLlmAnnotation returns undefined for unknown input_hash", () => {
    const row = h.store.getLlmAnnotation("never-stored");
    expect(row).toBeUndefined();
  });

  it("getEdgesForEntity returns seed edges where entity is source or target", () => {
    const out = h.store.getEdgesForEntity("herta.person.prime");
    expect(out.length).toBeGreaterThanOrEqual(4);
    const relations = new Set(out.map((e) => e.relation));
    expect(relations.has("controls_or_uses")).toBe(true);
    expect(relations.has("owns")).toBe(true);
    expect(relations.has("member_of")).toBe(true);
  });

  it("getEdgesForEntity returns empty array for an entity with no edges", () => {
    const out = h.store.getEdgesForEntity("herta.name.ambiguous");
    expect(out).toEqual([]);
  });

  it("getChunkWithDocument joins chunk with its parent document", () => {
    h.store.upsertDocument({
      id: "doc-cd1",
      kind: "world_lore",
      title: "Test Title",
      path: "data/test.html",
      url: "https://example.com/p/1",
      sourceHash: "h",
      createdAt: new Date().toISOString(),
    });
    h.store.insertChunk({
      id: "chunk-cd1",
      documentId: "doc-cd1",
      ordinal: 0,
      sectionPath: ["section"],
      text: "hello",
      textHash: "th",
      tokenEstimate: 1,
      isDialogue: false,
      isHertaVoiceEvidence: false,
      isCanonFactCandidate: false,
      qualityScore: 0,
    });
    const out = h.store.getChunkWithDocument("chunk-cd1");
    expect(out?.chunk.text).toBe("hello");
    expect(out?.document.title).toBe("Test Title");
    expect(out?.document.path).toBe("data/test.html");
    expect(out?.document.url).toBe("https://example.com/p/1");
  });

  it("getChunkWithDocument returns undefined for unknown chunk", () => {
    expect(h.store.getChunkWithDocument("never-stored")).toBeUndefined();
  });

  it("resolveAmbiguousAlias returns concrete referents for an ambiguous alias", () => {
    const candidates = h.store.resolveAmbiguousAlias("黑塔");
    const ids = candidates.map((c) => c.entityId).sort();
    expect(ids).toEqual([
      "herta.form.doll",
      "herta.person.prime",
      "herta.place.space_station",
      "herta.work.manuscript",
    ]);
  });

  it("resolveAmbiguousAlias returns single entity for a non-ambiguous alias", () => {
    const candidates = h.store.resolveAmbiguousAlias("天才俱乐部");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.entityId).toBe("faction.genius_society");
    expect(candidates[0]?.canonicalName).toBe("天才俱乐部");
  });

  it("resolveAmbiguousAlias returns empty array for unknown alias", () => {
    expect(h.store.resolveAmbiguousAlias("nonexistent-alias")).toEqual([]);
  });

  describe("claims", () => {
    it("inserts an entity-valued claim and round-trips fields", () => {
      h.store.insertClaim({
        id: "claim:test:1",
        subjectEntityId: "herta.person.prime",
        predicate: "manifestation_of",
        objectEntityId: "herta.form.doll",
        evidenceChunkIds: [],
        confidence: 1.0,
        method: "deterministic",
        status: "active",
        createdAt: "2026-05-06T00:00:00.000Z",
      });
      const rows = h.store.getClaimsBySubject("herta.person.prime");
      expect(rows).toHaveLength(1);
      const claim = rows[0];
      if (claim === undefined) throw new Error("claim missing");
      expect(claim.predicate).toBe("manifestation_of");
      expect(claim.objectEntityId).toBe("herta.form.doll");
      expect(claim.value).toBeUndefined();
      expect(claim.evidenceChunkIds).toEqual([]);
      expect(claim.status).toBe("active");
    });

    it("inserts a literal-valued claim with evidence chunk ids", () => {
      h.store.insertClaim({
        id: "claim:test:2",
        subjectEntityId: "herta.person.prime",
        predicate: "member_number",
        value: "#83",
        evidenceChunkIds: ["chunk:fake:1", "chunk:fake:2"],
        confidence: 0.9,
        method: "deterministic",
        status: "active",
        rationale: "regex match: 成员编号#83",
        createdAt: "2026-05-06T00:00:00.000Z",
      });
      const rows = h.store.getClaimsBySubject("herta.person.prime");
      expect(rows).toHaveLength(1);
      const claim = rows[0];
      if (claim === undefined) throw new Error("claim missing");
      expect(claim.value).toBe("#83");
      expect(claim.evidenceChunkIds).toEqual(["chunk:fake:1", "chunk:fake:2"]);
    });

    it("upserts on duplicate id (idempotent re-extraction)", () => {
      const base = {
        id: "claim:test:3",
        subjectEntityId: "herta.person.prime",
        predicate: "member_of",
        objectEntityId: "faction.genius_society",
        evidenceChunkIds: [],
        confidence: 1.0,
        method: "deterministic" as const,
        status: "active" as const,
        createdAt: "2026-05-06T00:00:00.000Z",
      };
      h.store.insertClaim(base);
      h.store.insertClaim({ ...base, confidence: 0.95 });
      expect(h.store.countClaims()).toBe(1);
      const rows = h.store.getClaimsBySubject("herta.person.prime");
      const claim = rows[0];
      if (claim === undefined) throw new Error("claim missing");
      expect(claim.confidence).toBeCloseTo(0.95, 5);
    });

    it("getActiveClaimsForPredicate returns only active claims, ranked by confidence", () => {
      h.store.insertClaim({
        id: "claim:test:active1",
        subjectEntityId: "herta.person.prime",
        predicate: "member_number",
        value: "#83",
        evidenceChunkIds: [],
        confidence: 0.9,
        method: "deterministic",
        status: "active",
        createdAt: "2026-05-06T00:00:00.000Z",
      });
      h.store.insertClaim({
        id: "claim:test:active2",
        subjectEntityId: "herta.person.prime",
        predicate: "member_number",
        value: "#83",
        evidenceChunkIds: [],
        confidence: 0.95,
        method: "deterministic",
        status: "active",
        createdAt: "2026-05-06T00:00:00.000Z",
      });
      h.store.insertClaim({
        id: "claim:test:obsolete",
        subjectEntityId: "herta.person.prime",
        predicate: "member_number",
        value: "#84",
        evidenceChunkIds: [],
        confidence: 0.99,
        method: "deterministic",
        status: "obsolete",
        createdAt: "2026-05-06T00:00:00.000Z",
      });
      const active = h.store.getActiveClaimsForPredicate("member_number");
      expect(active.map((c) => c.id)).toEqual([
        "claim:test:active2",
        "claim:test:active1",
      ]);
    });

    it("updateClaimEvidence replaces evidence chunk ids and bumps confidence", () => {
      h.store.insertClaim({
        id: "claim:upd:1",
        subjectEntityId: "herta.person.prime",
        predicate: "member_number",
        value: "#83",
        evidenceChunkIds: ["chunk:a"],
        confidence: 0.85,
        method: "llm",
        status: "active",
        createdAt: "2026-05-06T00:00:00.000Z",
      });
      h.store.updateClaimEvidence("claim:upd:1", ["chunk:a", "chunk:b"], 0.91);
      const rows = h.store.getClaimsBySubject("herta.person.prime");
      const c = rows.find((r) => r.id === "claim:upd:1");
      if (c === undefined) throw new Error("missing");
      expect([...c.evidenceChunkIds].sort()).toEqual(["chunk:a", "chunk:b"]);
      expect(c.confidence).toBeCloseTo(0.91, 5);
    });

    it("getActiveClaimsForKey returns active claims with matching subject+predicate", () => {
      h.store.insertClaim({
        id: "claim:k:1",
        subjectEntityId: "herta.person.prime",
        predicate: "member_number",
        value: "#83",
        evidenceChunkIds: [],
        confidence: 1.0,
        method: "deterministic",
        status: "active",
        createdAt: "2026-05-06T00:00:00.000Z",
      });
      h.store.insertClaim({
        id: "claim:k:2",
        subjectEntityId: "herta.person.prime",
        predicate: "member_number",
        value: "#84",
        evidenceChunkIds: [],
        confidence: 0.9,
        method: "deterministic",
        status: "obsolete",
        createdAt: "2026-05-06T00:00:00.000Z",
      });
      h.store.insertClaim({
        id: "claim:k:3",
        subjectEntityId: "herta.person.prime",
        predicate: "owns",
        objectEntityId: "herta.place.space_station",
        evidenceChunkIds: [],
        confidence: 1.0,
        method: "deterministic",
        status: "active",
        createdAt: "2026-05-06T00:00:00.000Z",
      });
      const hits = h.store.getActiveClaimsForKey(
        "herta.person.prime",
        "member_number",
      );
      expect(hits.map((c) => c.id)).toEqual(["claim:k:1"]);
    });

    it("listEntityIds returns every entity id in the table as a Set", () => {
      const ids = h.store.listEntityIds();
      expect(ids.has("herta.person.prime")).toBe(true);
      expect(ids.has("herta.form.doll")).toBe(true);
      expect(ids.has("faction.genius_society")).toBe(true);
      expect(ids.has("not.a.real.entity")).toBe(false);
    });
  });

  describe("wiki pages", () => {
    it("upsertWikiPage round-trips the structured content", () => {
      const now = "2026-05-06T00:00:00.000Z";
      const page = {
        entityId: "herta.person.prime",
        entityType: "person" as const,
        canonicalName: "大黑塔",
        aliases: [],
        relationships: [],
        attributes: [],
        voiceEvidence: [],
        uncertainClaims: [],
        claimIds: ["claim:seed:abc"],
        sourceChunkIds: [],
        generatedAt: now,
      };
      h.store.upsertWikiPage(page);
      const got = h.store.getWikiPage("herta.person.prime");
      expect(got?.entityId).toBe("herta.person.prime");
      expect(got?.canonicalName).toBe("大黑塔");
      expect(got?.claimIds).toEqual(["claim:seed:abc"]);
    });

    it("upsertWikiPage replaces on conflict (idempotent)", () => {
      const base = {
        entityId: "herta.person.prime",
        entityType: "person" as const,
        canonicalName: "大黑塔",
        aliases: [],
        relationships: [],
        attributes: [],
        voiceEvidence: [],
        uncertainClaims: [],
        claimIds: [],
        sourceChunkIds: [],
        generatedAt: "2026-05-06T00:00:00.000Z",
      };
      h.store.upsertWikiPage(base);
      h.store.upsertWikiPage({
        ...base,
        canonicalName: "大黑塔 (updated)",
        generatedAt: "2026-05-06T00:00:01.000Z",
      });
      expect(h.store.countWikiPages()).toBe(1);
      const got = h.store.getWikiPage("herta.person.prime");
      expect(got?.canonicalName).toBe("大黑塔 (updated)");
    });

    it("listWikiPageEntityIds returns all keys", () => {
      const base = {
        entityType: "person" as const,
        canonicalName: "n/a",
        aliases: [],
        relationships: [],
        attributes: [],
        voiceEvidence: [],
        uncertainClaims: [],
        claimIds: [],
        sourceChunkIds: [],
        generatedAt: "2026-05-06T00:00:00.000Z",
      };
      h.store.upsertWikiPage({ ...base, entityId: "herta.person.prime" });
      h.store.upsertWikiPage({ ...base, entityId: "herta.form.doll" });
      const ids = h.store.listWikiPageEntityIds().sort();
      expect(ids).toEqual(["herta.form.doll", "herta.person.prime"]);
    });
  });

  describe("voice evidence strata", () => {
    function mkStratum(
      overrides: Partial<VoiceEvidenceStratum> = {},
    ): VoiceEvidenceStratum {
      return {
        chunkId: "chunk:vs:1",
        speakerEntityId: HERTA_PERSON_PRIME,
        addresseeClass: "player",
        classifierVersion: 1,
        classifiedAt: "2026-05-08T00:00:00.000Z",
        ...overrides,
      };
    }

    it("upsertVoiceEvidenceStratum + getVoiceEvidenceStratum round-trips", () => {
      const s = mkStratum({
        chunkId: "chunk:vs:rt",
        addresseeClass: "other_named",
        addresseeEntityId: "person.screwllum",
      });
      h.store.upsertVoiceEvidenceStratum(s);
      const got = h.store.getVoiceEvidenceStratum("chunk:vs:rt");
      expect(got).toEqual(s);
    });

    it("getVoiceEvidenceStratum returns undefined for unknown chunk", () => {
      expect(h.store.getVoiceEvidenceStratum("never-stored")).toBeUndefined();
    });

    it("upsertVoiceEvidenceStratum is idempotent — second write replaces", () => {
      const s = mkStratum({ chunkId: "chunk:vs:idem", classifierVersion: 1 });
      h.store.upsertVoiceEvidenceStratum(s);
      h.store.upsertVoiceEvidenceStratum({ ...s, classifierVersion: 2 });
      const got = h.store.getVoiceEvidenceStratum("chunk:vs:idem");
      expect(got?.classifierVersion).toBe(2);
      expect(h.store.countStrata(HERTA_PERSON_PRIME)).toBe(1);
    });

    it("listStrataByClass filters by speaker + class", () => {
      h.store.upsertVoiceEvidenceStratum(
        mkStratum({ chunkId: "chunk:vs:p1", addresseeClass: "player" }),
      );
      h.store.upsertVoiceEvidenceStratum(
        mkStratum({ chunkId: "chunk:vs:p2", addresseeClass: "player" }),
      );
      h.store.upsertVoiceEvidenceStratum(
        mkStratum({
          chunkId: "chunk:vs:o1",
          addresseeClass: "other_named",
          addresseeEntityId: "person.screwllum",
        }),
      );
      const players = h.store.listStrataByClass(HERTA_PERSON_PRIME, "player");
      expect(players.map((s) => s.chunkId).sort()).toEqual([
        "chunk:vs:p1",
        "chunk:vs:p2",
      ]);
      const others = h.store.listStrataByClass(
        HERTA_PERSON_PRIME,
        "other_named",
      );
      expect(others).toHaveLength(1);
      expect(others[0]?.addresseeEntityId).toBe("person.screwllum");
    });

    it("countStrata returns total when class is omitted, filtered when given", () => {
      h.store.upsertVoiceEvidenceStratum(
        mkStratum({ chunkId: "chunk:vs:c1", addresseeClass: "player" }),
      );
      h.store.upsertVoiceEvidenceStratum(
        mkStratum({ chunkId: "chunk:vs:c2", addresseeClass: "player" }),
      );
      h.store.upsertVoiceEvidenceStratum(
        mkStratum({ chunkId: "chunk:vs:c3", addresseeClass: "unknown" }),
      );
      expect(h.store.countStrata(HERTA_PERSON_PRIME)).toBe(3);
      expect(h.store.countStrata(HERTA_PERSON_PRIME, "player")).toBe(2);
      expect(h.store.countStrata(HERTA_PERSON_PRIME, "self_narration")).toBe(0);
    });
  });

  describe("voice profiles", () => {
    function mkProfile(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
      return {
        entityId: HERTA_PERSON_PRIME,
        schemaVersion: VOICE_PROFILE_SCHEMA_VERSION,
        defaultRegister: {
          formsOfAddress: [
            {
              phrase: "小家伙",
              evidenceChunkIds: ["chunk:a", "chunk:b"],
              contextHint: "teaching",
            },
          ],
          toneInvariants: [
            { pattern: "dry, exact", evidenceChunkIds: ["chunk:c"] },
          ],
          codeSwitchTriggers: [],
          moodModulators: {
            pleased: [{ pattern: "嘿~", evidenceChunkIds: ["chunk:d"] }],
          },
        },
        relationshipRegisters: {},
        antiPatterns: [
          {
            pattern: "no modern internet slang",
            rationale: "no evidence across player register",
            evidenceAbsenceClaim: "absent across all 47 player chunks",
          },
        ],
        evidenceChunkIds: ["chunk:a", "chunk:b", "chunk:c", "chunk:d"],
        generatedAt: "2026-05-08T00:00:00.000Z",
        sourceRound: 2,
        ...overrides,
      };
    }

    it("upsertVoiceProfile round-trips all JSON fields", () => {
      const p = mkProfile();
      h.store.upsertVoiceProfile(p);
      const got = h.store.getVoiceProfile(HERTA_PERSON_PRIME);
      expect(got).toEqual(p);
    });

    it("getVoiceProfile returns undefined for unknown entity", () => {
      expect(h.store.getVoiceProfile("not.an.entity")).toBeUndefined();
    });

    it("upsertVoiceProfile is idempotent on entityId", () => {
      const p = mkProfile({ sourceRound: 2 });
      h.store.upsertVoiceProfile(p);
      h.store.upsertVoiceProfile({ ...p, sourceRound: 3 });
      const got = h.store.getVoiceProfile(HERTA_PERSON_PRIME);
      expect(got?.sourceRound).toBe(3);
    });

    it("round-trips selfNarration when populated", () => {
      const p = mkProfile({
        selfNarration: {
          formsOfAddress: [],
          toneInvariants: [
            {
              pattern: "first-person reflective tone",
              evidenceChunkIds: ["chunk:sn:1", "chunk:sn:2"],
            },
          ],
          codeSwitchTriggers: [],
          moodModulators: {
            interested: [
              { pattern: "嗯…有意思", evidenceChunkIds: ["chunk:sn:3"] },
            ],
          },
        },
      });
      h.store.upsertVoiceProfile(p);
      const got = h.store.getVoiceProfile(HERTA_PERSON_PRIME);
      expect(got?.selfNarration).toBeDefined();
      expect(got?.selfNarration?.toneInvariants).toHaveLength(1);
      expect(got?.selfNarration?.toneInvariants[0]?.pattern).toBe(
        "first-person reflective tone",
      );
      expect(got?.selfNarration?.moodModulators.interested).toHaveLength(1);
    });

    it("returns selfNarration=undefined when the column holds the empty-object sentinel", () => {
      // The default mkProfile() does not set selfNarration → upsert writes "{}".
      h.store.upsertVoiceProfile(mkProfile());
      const got = h.store.getVoiceProfile(HERTA_PERSON_PRIME);
      expect(got).toBeDefined();
      expect(got?.selfNarration).toBeUndefined();
    });
  });

  describe("v6 — voice_evidence_strata LLM extensions", () => {
    it("upsertVoiceEvidenceStratumLlm round-trips all new columns", () => {
      const h2 = mkTempKnowledgeDb();
      h2.store.upsertVoiceEvidenceStratumLlm({
        chunkId: "c1",
        speakerEntityId: "herta.person.prime",
        addresseeClass: "player",
        addresseeEntityId: undefined,
        classifierVersion: 3,
        classifiedAt: "2026-05-09T00:00:00Z",
        addresseeEntityIdLlm: undefined,
        mood: "interested",
        registerMode: "teaching",
        groundedCitation: "你看看这段代码",
        confidence: 0.9,
        source: "consensus",
        disagreementWithHeuristic: false,
        passAVerdictJson: '{"x":1}',
        passBVerdictJson: '{"x":1}',
      });
      const got = h2.store.getVoiceEvidenceStratumLlm("c1");
      expect(got?.source).toBe("consensus");
      expect(got?.mood).toBe("interested");
      expect(got?.confidence).toBe(0.9);
      expect(got?.groundedCitation).toBe("你看看这段代码");
      h2.cleanup();
    });
  });

  describe("v3 voice evidence chunk helpers", () => {
    it("getVoiceEvidenceChunksForEntity returns voice-evidence chunks for a person, ordered by quality", () => {
      h.store.upsertDocument({
        id: "doc:v1",
        kind: "mission_dialogue",
        title: "天才群星闪耀时",
        path: "data/test/mission.html",
        sourceHash: "vh1",
        createdAt: "2026-05-06T00:00:00.000Z",
      });
      h.store.insertChunk({
        id: "chunk:v1",
        documentId: "doc:v1",
        ordinal: 0,
        sectionPath: ["剧情", "对话"],
        speaker: "黑塔",
        speakerEntityId: "herta.person.prime",
        text: "本人远程操纵此处的人偶。",
        textHash: "th1",
        tokenEstimate: 12,
        isDialogue: true,
        isHertaVoiceEvidence: true,
        isCanonFactCandidate: false,
        qualityScore: 0.9,
      });
      h.store.insertChunk({
        id: "chunk:v2",
        documentId: "doc:v1",
        ordinal: 1,
        sectionPath: ["剧情", "对话"],
        speaker: "黑塔",
        speakerEntityId: "herta.person.prime",
        text: "实验。",
        textHash: "th2",
        tokenEstimate: 3,
        isDialogue: true,
        isHertaVoiceEvidence: true,
        isCanonFactCandidate: false,
        qualityScore: 0.5,
      });
      const chunks = h.store.getVoiceEvidenceChunksForEntity(
        "herta.person.prime",
        2,
      );
      expect(chunks).toHaveLength(2);
      expect(chunks[0]?.chunkId).toBe("chunk:v1"); // higher qualityScore first
      expect(chunks[0]?.documentTitle).toBe("天才群星闪耀时");
      expect(chunks[0]?.sectionPath).toEqual(["剧情", "对话"]);
    });
  });

  describe("self-models (Phase 6)", () => {
    it("inserts and reads back the latest row by entity", () => {
      const id = h.store.insertSelfModel({
        entityId: HERTA_PERSON_PRIME,
        schemaVersion: 1,
        payloadJson: '{"version":1,"biography":{"prose":"..."}}',
        judgeReportJson: '{"avgScore":4.93}',
        sourceFactsHash: "sha256:abc",
        shippedAt: "2026-05-11T00:00:00.000Z",
      });
      expect(id).toBeGreaterThan(0);

      const row = h.store.getLatestSelfModel(HERTA_PERSON_PRIME);
      expect(row).toBeDefined();
      expect(row?.id).toBe(id);
      expect(row?.entityId).toBe(HERTA_PERSON_PRIME);
      expect(row?.schemaVersion).toBe(1);
      expect(row?.judgeReportJson).toBe('{"avgScore":4.93}');
      expect(row?.sourceFactsHash).toBe("sha256:abc");
    });

    it("getLatestSelfModel returns the most-recent ship per entity", () => {
      h.store.insertSelfModel({
        entityId: HERTA_PERSON_PRIME,
        schemaVersion: 1,
        payloadJson: '{"v":1}',
        judgeReportJson: null,
        sourceFactsHash: null,
        shippedAt: "2026-05-10T00:00:00.000Z",
      });
      h.store.insertSelfModel({
        entityId: HERTA_PERSON_PRIME,
        schemaVersion: 1,
        payloadJson: '{"v":2}',
        judgeReportJson: null,
        sourceFactsHash: null,
        shippedAt: "2026-05-11T00:00:00.000Z",
      });
      const latest = h.store.getLatestSelfModel(HERTA_PERSON_PRIME);
      expect(latest?.payloadJson).toBe('{"v":2}');
      expect(latest?.shippedAt).toBe("2026-05-11T00:00:00.000Z");
    });

    it("returns undefined when no row exists for the entity", () => {
      expect(h.store.getLatestSelfModel(HERTA_PERSON_PRIME)).toBeUndefined();
    });

    it("listSelfModelHistory returns all ships newest-first", () => {
      h.store.insertSelfModel({
        entityId: HERTA_PERSON_PRIME,
        schemaVersion: 1,
        payloadJson: '{"v":1}',
        judgeReportJson: null,
        sourceFactsHash: "h1",
        shippedAt: "2026-05-10T00:00:00.000Z",
      });
      h.store.insertSelfModel({
        entityId: HERTA_PERSON_PRIME,
        schemaVersion: 1,
        payloadJson: '{"v":2}',
        judgeReportJson: null,
        sourceFactsHash: "h2",
        shippedAt: "2026-05-11T00:00:00.000Z",
      });
      const history = h.store.listSelfModelHistory(HERTA_PERSON_PRIME);
      expect(history).toHaveLength(2);
      expect(history[0]?.sourceFactsHash).toBe("h2");
      expect(history[1]?.sourceFactsHash).toBe("h1");
    });

    it("rejects ships against unknown entity_id (FK)", () => {
      expect(() =>
        h.store.insertSelfModel({
          entityId: "ghost.entity",
          schemaVersion: 1,
          payloadJson: "{}",
          judgeReportJson: null,
          sourceFactsHash: null,
          shippedAt: "2026-05-11T00:00:00.000Z",
        }),
      ).toThrow(/FOREIGN KEY/i);
    });
  });
});
