// Phase 1 + 2 + 3 + 4 exports — schemas, HTML cleaning, corpus expansion,
// fact extraction, synthesis, programmatic checks, LLM-judge.

export { extractFromBrStructure } from "./br-fallback-extractor.js";
export {
  type CorpusGrepInput,
  categorizeFromPath,
  grepCorpusForHerta,
} from "./corpus-grep.js";
export {
  type ExtractionWarning,
  type ParseExtractionOutputInput,
  type ParseExtractionOutputResult,
  parseExtractionOutput,
} from "./extract-output-validator.js";
export {
  type BuildExtractionPromptInput,
  buildExtractionPrompt,
  type ExtractionPrompt,
} from "./extract-prompt.js";
export { formatCleanedText } from "./format-cleaned-text.js";
export {
  type BuildJudgePromptInput,
  buildJudgePrompt,
  type JudgePrompt,
} from "./judge-prompt.js";
export {
  type ProgrammaticCheckFailure,
  type ProgrammaticChecksInput,
  type ProgrammaticChecksResult,
  runProgrammaticChecks,
} from "./programmatic-checks.js";
export {
  type CleanedFile,
  type CleanPassInput,
  type CleanPassResult,
  runCleanPass,
} from "./run-clean-pass.js";
export {
  type ExpandCorpusInput,
  runExpandCorpusPass,
} from "./run-expand-corpus-pass.js";
export {
  type RunExtractPassInput,
  type RunExtractPassResult,
  runExtractPass,
} from "./run-extract-pass.js";
export {
  type RunJudgePassInput,
  type RunJudgePassResult,
  runJudgePass,
} from "./run-judge-pass.js";
export {
  type RunSynthesizePassInput,
  type RunSynthesizePassResult,
  runSynthesizePass,
} from "./run-synthesize-pass.js";
export {
  type CandidateCategory,
  type CorpusCandidate,
  type CorpusManifest,
  candidateCategorySchema,
  corpusCandidateSchema,
  corpusManifestSchema,
  type FactItem,
  type FactKind,
  type FileFacts,
  factItemSchema,
  factKindSchema,
  fileFactsSchema,
  type HertaFacts,
  type HertaSelfModelV1,
  hertaFactsSchema,
  hertaSelfModelV1Schema,
  type JudgeReport,
  judgeReportSchema,
  type SelfModelSemanticSlot,
} from "./schema.js";
export {
  type ParseSynthesisOutputResult,
  parseSynthesisOutput,
  type SynthesisWarning,
} from "./synthesize-output-validator.js";
export {
  type BuildSynthesisPromptInput,
  buildSynthesisPrompt,
  type SynthesisPrompt,
} from "./synthesize-prompt.js";
