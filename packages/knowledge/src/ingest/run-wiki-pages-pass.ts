import type { CanonClaim, CanonEntityType } from "../schema.js";
import type { SqliteKnowledgeStore } from "../store/sqlite-knowledge-store.js";
import { buildWikiPage } from "./build-wiki-page.js";

export interface RunWikiPagesPassInput {
  store: SqliteKnowledgeStore;
  now: string;
  voiceEvidenceLimit?: number;
}

export interface RunWikiPagesPassResult {
  pagesWritten: number;
  entitiesSkipped: number;
}

const VOICE_KINDS = new Set<CanonEntityType>(["person", "manifestation"]);
const DEFAULT_VOICE_LIMIT = 5;

export function runWikiPagesPass(
  input: RunWikiPagesPassInput,
): RunWikiPagesPassResult {
  const { store, now } = input;
  const voiceLimit = input.voiceEvidenceLimit ?? DEFAULT_VOICE_LIMIT;
  const entities = store.listEntities();

  const nameLookup = new Map<string, string>();
  for (const e of entities) nameLookup.set(e.id, e.canonicalName);

  let pagesWritten = 0;
  let entitiesSkipped = 0;

  for (const entity of entities) {
    const allForSubject = store.getClaimsBySubject(entity.id);
    const activeClaims: CanonClaim[] = allForSubject.filter(
      (c) => c.status === "active",
    );
    const needsReviewClaims: CanonClaim[] = allForSubject.filter(
      (c) => c.status === "needs_review",
    );
    if (activeClaims.length === 0 && needsReviewClaims.length === 0) {
      entitiesSkipped += 1;
      continue;
    }

    const aliases = store.getAliases(entity.id).map((a) => ({
      alias: a.alias,
      lang: a.lang ?? undefined,
      priority: a.priority,
    }));

    const voiceEvidence = VOICE_KINDS.has(entity.type as CanonEntityType)
      ? store.getVoiceEvidenceChunksForEntity(entity.id, voiceLimit)
      : [];

    const page = buildWikiPage({
      entity: {
        id: entity.id,
        type: entity.type as CanonEntityType,
        canonicalName: entity.canonicalName,
        description: entity.description ?? undefined,
      },
      aliases,
      activeClaims,
      needsReviewClaims,
      voiceEvidence,
      entityNameLookup: nameLookup,
      now,
    });
    store.upsertWikiPage(page);
    pagesWritten += 1;
  }

  return { pagesWritten, entitiesSkipped };
}
