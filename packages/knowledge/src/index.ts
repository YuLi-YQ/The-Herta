export const KNOWLEDGE_PACKAGE_NAME = "@herta/knowledge" as const;
export { runKnowledgeCli } from "./cli/herta-knowledge.js";
export {
  countHertaTurns,
  DEFAULT_DREAM_CONFIG,
  type DreamConfig,
  type DreamSessionInput,
  episodeHash,
  hasEnoughMaterial,
  isModifiedSince,
  lastFullPassAtMs,
  type MaterialThresholds,
  type PromptExclusionInputs,
  type RunDreamPassOptions,
  type RunDreamPassResult,
  readManifest,
  resolveDreamConfig,
  runDreamPass,
  segmentSession,
  selectPromptExclusions,
} from "./dream/index.js";
export {
  type AlignedTerm,
  defaultTextMapDir,
  type GlossarySearchOptions,
  loadTextMap,
  searchAlignedTerms,
  TEXTMAP_CN_FILENAME,
  TEXTMAP_EN_FILENAME,
} from "./glossary/textmap-glossary.js";
export {
  type ApplyClaimResolutionInput,
  type ApplyClaimResolutionResult,
  applyClaimResolution,
} from "./ingest/apply-claim-resolution.js";
export {
  type BuildWikiPageEntity,
  type BuildWikiPageInput,
  buildWikiPage,
} from "./ingest/build-wiki-page.js";
export { resolveClaim } from "./ingest/claim-resolver.js";
export {
  type ChunkSignal,
  type ClaimExtractorInput,
  extractDeterministicClaims,
} from "./ingest/deterministic-claim-extractor.js";
export {
  type ExtractClaimsPassInput,
  type ExtractClaimsPassResult,
  runExtractClaimsPass,
} from "./ingest/extract-claims-pass.js";
export { ingestCorpus } from "./ingest/ingest-corpus.js";
export {
  type RunLlmClaimsLlmOptions,
  type RunLlmClaimsPassInput,
  type RunLlmClaimsPassResult,
  runLlmClaimsPass,
} from "./ingest/run-llm-claims-pass.js";
export {
  type RunWikiPagesPassInput,
  type RunWikiPagesPassResult,
  runWikiPagesPass,
} from "./ingest/run-wiki-pages-pass.js";
export {
  type ClaimCandidateInput,
  selectClaimCandidates,
} from "./ingest/select-claim-candidates.js";
export {
  type BuildClaimExtractionRequestOptions,
  buildClaimExtractionRequest,
  CLAIM_EXTRACTION_SYSTEM_PROMPT,
  type ClaimChunkInput,
} from "./llm/claim-extraction-prompt.js";
export {
  type ClaimValidationResult,
  parseAndValidateClaimOutput,
  type RejectedClaim,
} from "./llm/claim-output-validator.js";
export { RealDeepSeekClient } from "./llm/deepseek-client.js";
export {
  type ResolvedKey,
  type ResolveKeyOptions,
  resolveDeepSeekApiKey,
} from "./llm/key-resolver.js";
export type { DeepSeekClient } from "./llm/types.js";
export { defaultDataDir, defaultDbPath, defaultReviewDir } from "./paths.js";
export {
  getPersonaComponent,
  PERSONA_COMPONENT_IDS,
  PERSONA_COMPONENTS,
  type PersonaComponentSpec,
  type PersonaPersistence,
} from "./persona/components.js";
export { PersonaStore } from "./persona/persona-store.js";
export {
  type ExtractScenesOpts,
  extractHertaScenes,
  type Scene,
  type SceneTurn,
} from "./retrieval/extract-scenes.js";
export * from "./schema.js";
export {
  type HertaSelfModelV1,
  hertaSelfModelV1Schema,
  type JudgeReport,
  judgeReportSchema,
  type SelfModelSemanticSlot,
} from "./self-model/schema.js";
export {
  type CanonEdgeRow,
  type ChunkWithDocument,
  type EntityCandidate,
  SqliteKnowledgeStore,
} from "./store/sqlite-knowledge-store.js";
export {
  ALIGN_NORMALIZATION_VERSION,
  type AlignChunkInput,
  type AlignmentIndex,
  type AlignOutcome,
  alignChunk,
  buildAlignmentIndex,
  normalizeForAlignment,
} from "./voice/align-translations.js";
export {
  type RunAlignPassOptions,
  type RunAlignPassResult,
  runAlignPass,
} from "./voice/run-align-pass.js";
