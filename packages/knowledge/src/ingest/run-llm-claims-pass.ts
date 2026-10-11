import { buildClaimExtractionRequest } from "../llm/claim-extraction-prompt.js";
import { parseAndValidateClaimOutput } from "../llm/claim-output-validator.js";
import type { DeepSeekClient } from "../llm/types.js";
import type { CanonDocumentKind } from "../schema.js";
import type { SqliteKnowledgeStore } from "../store/sqlite-knowledge-store.js";
import { sha1 } from "../text-utils.js";
import { applyClaimResolution } from "./apply-claim-resolution.js";
import { selectClaimCandidates } from "./select-claim-candidates.js";

export interface RunLlmClaimsLlmOptions {
  client: DeepSeekClient;
  model: string;
  maxChunks: number;
  concurrency: number;
}

export interface RunLlmClaimsPassInput {
  store: SqliteKnowledgeStore;
  now: string;
  llm: RunLlmClaimsLlmOptions;
}

export interface RunLlmClaimsPassResult {
  proposed: number;
  accepted: number;
  merged: number;
  needsReview: number;
  rejected: number;
}

const KNOWN_PREDICATES: ReadonlyArray<string> = [
  "alias_of",
  "manifestation_of",
  "controls_or_uses",
  "owns",
  "member_of",
  "associated_with",
  "created",
  "authored",
  "member_number",
];
const ALLOWED_PREDICATE_SET: ReadonlySet<string> = new Set(KNOWN_PREDICATES);

const PREDICATE_DEFINITIONS: Readonly<Record<string, string>> = {
  alias_of:
    "subject is an alias of the object entity (use only for true synonymy).",
  manifestation_of:
    "subject is a manifestation/embodiment of the object (e.g. a doll of a person).",
  controls_or_uses:
    "subject controls or operates the object (a person controlling a doll, station, etc.).",
  owns: "subject owns the object (a person owning a place or work).",
  member_of: "subject is a member of the object (an organization or faction).",
  associated_with:
    "subject is meaningfully associated with the object via a connection the text states explicitly (e.g. works on, collaborates with, visits). Do not use for vague proximity, shared topic, or 'mentioned together'.",
  created: "subject created the object.",
  authored: "subject authored the object (work, manuscript, paper).",
  member_number:
    "subject's identifier within an organization. Object_entity_id MUST be omitted; value is the literal id (e.g. '#83').",
};

export async function runLlmClaimsPass(
  input: RunLlmClaimsPassInput,
): Promise<RunLlmClaimsPassResult> {
  const { store, now, llm } = input;
  const allChunks = store.listChunkSignalsForLlmClaims();
  const candidateIndex = selectClaimCandidates(
    allChunks.map((c) => ({
      chunkId: c.chunkId,
      documentKind: c.documentKind,
      isCanonFactCandidate: c.isCanonFactCandidate,
      isHertaVoiceEvidence: c.isHertaVoiceEvidence,
      mentions: c.mentions,
    })),
    llm.maxChunks,
  );
  if (candidateIndex.length === 0) {
    return {
      proposed: 0,
      accepted: 0,
      merged: 0,
      needsReview: 0,
      rejected: 0,
    };
  }
  const candidateIds = new Set(candidateIndex.map((c) => c.chunkId));
  const fullCandidates = allChunks.filter((c) => candidateIds.has(c.chunkId));
  const allowedEntityIds = store.listEntityIds();

  let proposed = 0;
  let accepted = 0;
  let merged = 0;
  let needsReview = 0;
  let rejected = 0;

  // Single-chunk batches; concurrency loops over slices.
  const batches: Array<typeof fullCandidates> = [];
  for (let i = 0; i < fullCandidates.length; i += llm.concurrency) {
    batches.push(fullCandidates.slice(i, i + llm.concurrency));
  }

  for (const batch of batches) {
    await Promise.all(
      batch.map(async (chunk) => {
        const req = buildClaimExtractionRequest({
          model: llm.model,
          knownEntityIds: [...allowedEntityIds],
          knownPredicates: KNOWN_PREDICATES,
          predicateDefinitions: PREDICATE_DEFINITIONS,
          chunks: [
            {
              chunkId: chunk.chunkId,
              documentTitle: chunk.documentTitle,
              documentKind: chunk.documentKind as CanonDocumentKind,
              sectionPath: chunk.sectionPath,
              speaker: chunk.speaker,
              text: chunk.text,
              mentions: chunk.mentions.map((m) => ({
                surface: m.surface,
                referentEntityId: m.referentEntityId,
              })),
            },
          ],
        });
        const inputHash = sha1(
          `${req.systemPrompt}\n${req.userPayload}\n${req.model}`,
        );
        let outputJson: string;
        const cached = store.getLlmAnnotation(inputHash);
        if (cached !== undefined) {
          outputJson = cached.outputJson;
        } else {
          const resp = await llm.client.chatJson(req);
          outputJson = resp.rawJsonText;
          store.upsertLlmAnnotation({
            id: `llm:${inputHash}`,
            chunkId: chunk.chunkId,
            provider: "deepseek",
            model: resp.model,
            task: "extract_canon_claims",
            inputHash,
            outputJson,
            createdAt: now,
          });
        }
        const validated = parseAndValidateClaimOutput(
          outputJson,
          new Set([chunk.chunkId]),
          allowedEntityIds,
          ALLOWED_PREDICATE_SET,
        );
        proposed += validated.accepted.length + validated.rejected.length;
        rejected += validated.rejected.length;
        for (const c of validated.accepted) {
          const r = applyClaimResolution({ store, candidate: c, now });
          if (r.kind === "add") accepted += 1;
          else if (r.kind === "merge_evidence") merged += 1;
          else if (r.kind === "needs_review") needsReview += 1;
        }
      }),
    );
  }

  return { proposed, accepted, merged, needsReview, rejected };
}
