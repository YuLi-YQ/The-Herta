import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { DeepSeekClient } from "../llm/types.js";
import { type CanonEntityId, HERTA_PERSON_PRIME } from "../schema.js";
import type { SqliteKnowledgeStore } from "../store/sqlite-knowledge-store.js";
import { reduceConsensus } from "./restratify-consensus.js";
import {
  buildRestratifyPromptA,
  buildRestratifyPromptB,
} from "./restratify-llm-prompt.js";
import { validateRestratifyOutput } from "./restratify-output-validator.js";

const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_CLASSIFIER_VERSION = 3;
const TASK = "voice_restratify_llm" as const;

export interface RunRestratifyLlmPassOptions {
  store: SqliteKnowledgeStore;
  client: DeepSeekClient;
  speakerEntityId?: CanonEntityId;
  classifierVersion?: number;
  model?: string;
  /** Abort the pass if heuristic-vs-LLM disagreement rate exceeds this. */
  abortOnDisagreementRate?: number;
  /** Process at most N docs. */
  sampleDocs?: number;
  /** No DB writes, no API calls. Returns estimated call count only. */
  dryRun?: boolean;
  now?: () => Date;
}

export interface RunRestratifyLlmPassResult {
  docsProcessed: number;
  chunksWithConsensus: number;
  chunksWithDisagreement: number;
  disagreementWithHeuristic: number;
  disagreementRate: number;
  aborted: boolean;
  estimatedCalls: number;
}

export async function runRestratifyLlmPass(
  opts: RunRestratifyLlmPassOptions,
): Promise<RunRestratifyLlmPassResult> {
  const speaker = opts.speakerEntityId ?? HERTA_PERSON_PRIME;
  const classifierVersion =
    opts.classifierVersion ?? DEFAULT_CLASSIFIER_VERSION;
  const model = opts.model ?? DEFAULT_MODEL;
  const clock = opts.now ?? (() => new Date());
  const knownEntityIds = new Set(opts.store.listAllEntityIds());

  const docs = opts.store.listDocsContainingSpeakerChunks(speaker);
  const slice =
    opts.sampleDocs !== undefined ? docs.slice(0, opts.sampleDocs) : docs;

  const result: RunRestratifyLlmPassResult = {
    docsProcessed: 0,
    chunksWithConsensus: 0,
    chunksWithDisagreement: 0,
    disagreementWithHeuristic: 0,
    disagreementRate: 0,
    aborted: false,
    estimatedCalls: slice.length * 2,
  };

  if (opts.dryRun) return result;

  let totalProcessedChunks = 0;

  for (const doc of slice) {
    if (!fs.existsSync(doc.path)) continue;
    const html = fs.readFileSync(doc.path, "utf8");
    const chunks = opts.store.listSpeakerChunksInDoc(speaker, doc.id);
    if (chunks.length === 0) continue;
    const anchorChunkId = chunks[0]?.id;
    if (anchorChunkId === undefined) continue;

    const promptInput = {
      sourceHtml: html,
      hertaChunks: chunks.map((c) => ({
        chunk_id: c.id,
        ordinal: c.ordinal,
        text: c.text,
      })),
    };
    const promptA = buildRestratifyPromptA(promptInput);
    const promptB = buildRestratifyPromptB(promptInput);

    const respA = await callWithCache(
      opts,
      promptA,
      doc.id,
      "A",
      anchorChunkId,
      model,
      clock,
    );
    const respB = await callWithCache(
      opts,
      promptB,
      doc.id,
      "B",
      anchorChunkId,
      model,
      clock,
    );

    const expected = chunks.map((c) => c.id);
    const ctx = {
      expectedChunkIds: expected,
      knownEntityIds,
      sourceHtml: html,
    };
    const outA = validateRestratifyOutput(respA, ctx);
    const outB = validateRestratifyOutput(respB, ctx);
    const byIdA = new Map(outA.classifications.map((c) => [c.chunk_id, c]));
    const byIdB = new Map(outB.classifications.map((c) => [c.chunk_id, c]));

    for (const chunk of chunks) {
      const a = byIdA.get(chunk.id);
      const b = byIdB.get(chunk.id);
      if (a === undefined || b === undefined) continue;
      const reduced = reduceConsensus(a, b);

      const prior = opts.store.getVoiceEvidenceStratumLlm(chunk.id);
      const heuristicAddressee =
        prior?.source === "heuristic" ? prior.addresseeClass : undefined;
      const heuristicEntity =
        prior?.source === "heuristic" ? prior.addresseeEntityId : undefined;
      const disagreement =
        heuristicAddressee !== undefined &&
        (heuristicAddressee !== reduced.addressee_class ||
          heuristicEntity !== reduced.addressee_entity_id);
      if (disagreement) result.disagreementWithHeuristic++;

      opts.store.upsertVoiceEvidenceStratumLlm({
        chunkId: chunk.id,
        speakerEntityId: speaker,
        addresseeClass: reduced.addressee_class,
        addresseeEntityId: reduced.addressee_entity_id as
          | CanonEntityId
          | undefined,
        classifierVersion,
        classifiedAt: clock().toISOString(),
        addresseeEntityIdLlm: reduced.addressee_entity_id_llm as
          | CanonEntityId
          | undefined,
        mood: reduced.mood,
        registerMode: reduced.register_mode,
        groundedCitation: reduced.grounded_citation || undefined,
        confidence: reduced.confidence,
        source: reduced.source,
        disagreementWithHeuristic: disagreement,
        passAVerdictJson: reduced.pass_a_verdict_json,
        passBVerdictJson: reduced.pass_b_verdict_json,
      });

      if (reduced.source === "consensus") result.chunksWithConsensus++;
      else result.chunksWithDisagreement++;
      totalProcessedChunks++;
    }
    result.docsProcessed++;

    if (
      opts.abortOnDisagreementRate !== undefined &&
      totalProcessedChunks > 0 &&
      result.disagreementWithHeuristic / totalProcessedChunks >
        opts.abortOnDisagreementRate
    ) {
      result.disagreementRate =
        result.disagreementWithHeuristic / totalProcessedChunks;
      result.aborted = true;
      return result;
    }
  }

  result.disagreementRate =
    totalProcessedChunks > 0
      ? result.disagreementWithHeuristic / totalProcessedChunks
      : 0;
  return result;
}

async function callWithCache(
  opts: RunRestratifyLlmPassOptions,
  prompt: { systemPrompt: string; userPayload: string },
  docId: string,
  passLabel: "A" | "B",
  anchorChunkId: string,
  model: string,
  clock: () => Date,
): Promise<string> {
  const inputHash = createHash("sha256")
    .update(prompt.systemPrompt)
    .update("\n---\n")
    .update(prompt.userPayload)
    .digest("hex");
  const cached = opts.store.getLlmAnnotation(inputHash);
  if (cached !== undefined) {
    return cached.outputJson;
  }
  const resp = await opts.client.chatJson({
    systemPrompt: prompt.systemPrompt,
    userPayload: prompt.userPayload,
    model,
  });
  opts.store.upsertLlmAnnotation({
    id: `llm:${inputHash}`,
    chunkId: anchorChunkId,
    provider: "deepseek",
    model: resp.model,
    task: `${TASK}:${docId}::${passLabel}`,
    inputHash,
    outputJson: resp.rawJsonText,
    createdAt: clock().toISOString(),
  });
  return resp.rawJsonText;
}
