import { z } from "zod";

const PROVENANCE_PASS = z.object({
  name: z.string(),
  model: z.string(),
});

const PROVENANCE = z.object({
  passes: z.array(PROVENANCE_PASS),
});

// ─── Corpus manifest (Pass 0.5 output) ───────────────────────────────

export const candidateCategorySchema = z.enum([
  "character_page",
  "book",
  "mission",
  "station_lore",
  "chronicle",
  "sim_universe",
  "incidental_mention",
]);
export type CandidateCategory = z.infer<typeof candidateCategorySchema>;

export const corpusCandidateSchema = z.object({
  path: z.string().min(1),
  mention_count: z.number().int().nonnegative(),
  snippet_previews: z.array(z.string()),
  accepted: z.boolean(),
  category: candidateCategorySchema,
});
export type CorpusCandidate = z.infer<typeof corpusCandidateSchema>;

export const corpusManifestSchema = z.object({
  version: z.literal(1),
  candidates: z.array(corpusCandidateSchema),
});
export type CorpusManifest = z.infer<typeof corpusManifestSchema>;

// ─── Pass 1 output (herta_facts.json) ────────────────────────────────

export const factKindSchema = z.enum([
  "biography",
  "philosophy",
  "embodiment",
  "relationship",
  "harness_proprioception",
  "anti_pattern",
  "interaction_register",
]);
export type FactKind = z.infer<typeof factKindSchema>;

export const factConfidenceSchema = z.enum(["high", "medium", "low"]);

export const factItemSchema = z.object({
  kind: factKindSchema,
  prose: z.string().min(1),
  evidence_excerpt: z.string().min(1).max(500),
  confidence: factConfidenceSchema,
});
export type FactItem = z.infer<typeof factItemSchema>;

export const fileFactsSchema = z.object({
  source: z.string().min(1),
  facts: z.array(factItemSchema),
});
export type FileFacts = z.infer<typeof fileFactsSchema>;

export const extractionFailureSchema = z.object({
  source: z.string().min(1),
  reason: z.string(),
});

export const hertaFactsSchema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  provenance: PROVENANCE,
  files: z.array(fileFactsSchema),
  failures: z.array(extractionFailureSchema),
});
export type HertaFacts = z.infer<typeof hertaFactsSchema>;

// ─── Pass 2 output (herta_self_model_v1.json) ────────────────────────

const evidenceArray = z.array(z.string());

const slotWithProseAndKeyFacts = z.object({
  prose: z.string().min(1),
  key_facts: z.array(
    z.object({
      fact: z.string().min(1),
      evidence: evidenceArray,
    }),
  ),
});
export type SelfModelSemanticSlot = z.infer<typeof slotWithProseAndKeyFacts>;

const relationshipEntry = z.object({
  prose: z.string().min(1),
  evidence: evidenceArray,
});

const interactionRegisterSchema = z.object({
  prose: z.string().min(1),
  samples: z.array(
    z.object({
      scenario: z.string().min(1),
      voice_sample: z.string().min(1),
    }),
  ),
});

const antiPatternEntry = z.object({
  rule: z.string().min(1),
  evidence: evidenceArray,
});

export const hertaSelfModelV1Schema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  provenance: PROVENANCE,
  biography: slotWithProseAndKeyFacts,
  philosophy: slotWithProseAndKeyFacts,
  embodiment: slotWithProseAndKeyFacts,
  relationships: z.record(z.string(), relationshipEntry),
  harness_proprioception: slotWithProseAndKeyFacts,
  anti_patterns: z.array(antiPatternEntry),
  interaction_register: interactionRegisterSchema,
});
export type HertaSelfModelV1 = z.infer<typeof hertaSelfModelV1Schema>;

// ─── Pass 3b output (judge_report.json) ──────────────────────────────

const slotScoresSchema = z.object({
  in_voice: z.number().int().min(0).max(5),
  canon_grounded: z.number().int().min(0).max(5),
  coherent: z.number().int().min(0).max(5),
  no_leakage: z.number().int().min(0).max(5),
  concerns: z.array(z.string()),
});

export const judgeReportSchema = z.object({
  version: z.literal(1),
  judged_at: z.string(),
  model: z.string(),
  scores: z.record(z.string(), slotScoresSchema),
});
export type JudgeReport = z.infer<typeof judgeReportSchema>;
