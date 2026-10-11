import type {
  CanonClaim,
  CanonEntityId,
  CanonEntityType,
  WikiAttribute,
  WikiPage,
  WikiRelationship,
  WikiUncertainClaim,
  WikiVoiceEvidence,
} from "../schema.js";

export interface BuildWikiPageEntity {
  id: CanonEntityId;
  type: CanonEntityType;
  canonicalName: string;
  description?: string;
}

export interface BuildWikiPageInput {
  entity: BuildWikiPageEntity;
  aliases: ReadonlyArray<{
    alias: string;
    lang?: string;
    priority: number;
  }>;
  activeClaims: ReadonlyArray<CanonClaim>;
  needsReviewClaims: ReadonlyArray<CanonClaim>;
  voiceEvidence: ReadonlyArray<WikiVoiceEvidence>;
  entityNameLookup: ReadonlyMap<string, string>;
  now: string;
}

export function buildWikiPage(input: BuildWikiPageInput): WikiPage {
  const {
    entity,
    aliases,
    activeClaims,
    needsReviewClaims,
    voiceEvidence,
    entityNameLookup,
    now,
  } = input;

  const sortedAliases = [...aliases].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.alias.localeCompare(b.alias);
  });

  const relationships: WikiRelationship[] = [];
  const attributes: WikiAttribute[] = [];

  for (const c of activeClaims) {
    if (c.objectEntityId !== undefined) {
      relationships.push({
        claimId: c.id,
        predicate: c.predicate,
        targetEntityId: c.objectEntityId,
        targetCanonicalName:
          entityNameLookup.get(c.objectEntityId) ?? c.objectEntityId,
        confidence: c.confidence,
        method: c.method,
        evidenceChunkIds: c.evidenceChunkIds,
        rationale: c.rationale,
      });
    } else if (c.value !== undefined) {
      attributes.push({
        claimId: c.id,
        predicate: c.predicate,
        value: c.value,
        confidence: c.confidence,
        method: c.method,
        evidenceChunkIds: c.evidenceChunkIds,
        rationale: c.rationale,
      });
    }
  }

  relationships.sort((a, b) => {
    if (a.predicate !== b.predicate)
      return a.predicate.localeCompare(b.predicate);
    return a.targetEntityId.localeCompare(b.targetEntityId);
  });
  attributes.sort((a, b) => {
    if (a.predicate !== b.predicate)
      return a.predicate.localeCompare(b.predicate);
    return a.value.localeCompare(b.value);
  });

  const uncertainClaims: WikiUncertainClaim[] = needsReviewClaims.map((c) => ({
    claimId: c.id,
    predicate: c.predicate,
    targetEntityId: c.objectEntityId,
    targetCanonicalName:
      c.objectEntityId !== undefined
        ? (entityNameLookup.get(c.objectEntityId) ?? c.objectEntityId)
        : undefined,
    value: c.value,
    confidence: c.confidence,
    method: c.method,
    reason: c.rationale,
  }));

  const claimIdSet = new Set<string>();
  for (const c of activeClaims) claimIdSet.add(c.id);
  for (const c of needsReviewClaims) claimIdSet.add(c.id);

  const sourceChunkSet = new Set<string>();
  for (const c of activeClaims)
    for (const e of c.evidenceChunkIds) sourceChunkSet.add(e);
  for (const c of needsReviewClaims)
    for (const e of c.evidenceChunkIds) sourceChunkSet.add(e);
  for (const v of voiceEvidence) sourceChunkSet.add(v.chunkId);

  return {
    entityId: entity.id,
    entityType: entity.type,
    canonicalName: entity.canonicalName,
    description: entity.description,
    aliases: sortedAliases,
    relationships,
    attributes,
    voiceEvidence,
    uncertainClaims,
    claimIds: [...claimIdSet].sort(),
    sourceChunkIds: [...sourceChunkSet].sort(),
    generatedAt: now,
  };
}
