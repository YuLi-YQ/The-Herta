import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { isMissingFsError } from "../fs-utils.js";
import { parseHtmlDocument } from "../html/parse-html.js";
import { buildDisambiguationRequest } from "../llm/disambiguation-prompt.js";
import {
  type LlmAnnotatedMention,
  parseAndValidateLlmOutput,
} from "../llm/output-validator.js";
import type { DeepSeekClient } from "../llm/types.js";
import { defaultDbPath, defaultReviewDir } from "../paths.js";
import type { CanonEntityId } from "../schema.js";
import { HERTA_NAME_AMBIGUOUS } from "../schema.js";
import { SqliteKnowledgeStore } from "../store/sqlite-knowledge-store.js";
import { sha1 } from "../text-utils.js";
import { applyLlmAnnotations } from "./apply-llm-annotations.js";
import { chunkParsedDocument, classifyDocumentKind } from "./chunker.js";
import { labelDocument } from "./deterministic-labeler.js";
import { runExtractClaimsPass } from "./extract-claims-pass.js";
import { applyMentionOverrides } from "./override-applier.js";
import { loadMentionOverrides } from "./override-loader.js";
import { ReviewWriter } from "./review-writer.js";
import {
  type RunLlmClaimsLlmOptions,
  type RunLlmClaimsPassResult,
  runLlmClaimsPass,
} from "./run-llm-claims-pass.js";
import {
  type RunWikiPagesPassResult,
  runWikiPagesPass,
} from "./run-wiki-pages-pass.js";
import { selectLlmCandidates } from "./select-llm-candidates.js";

export interface IngestLlmOptions {
  client: DeepSeekClient;
  model: string;
  maxChunks: number;
  concurrency: number;
}

export interface IngestOptions {
  dataRoot: string;
  workspaceRoot: string;
  dbPath?: string;
  reviewDir?: string;
  force?: boolean;
  llm?: IngestLlmOptions;
  extractClaims?: boolean; // default true
  llmClaims?: RunLlmClaimsLlmOptions;
  buildWiki?: boolean; // default true
}

export interface IngestResult {
  fileCount: number;
  chunkCount: number;
  ambiguousMentions: number;
  claimsCount: number;
  llmClaims?: RunLlmClaimsPassResult;
  wikiPagesCount: number;
}

export async function ingestCorpus(opts: IngestOptions): Promise<IngestResult> {
  const dbPath = opts.dbPath ?? defaultDbPath(opts.workspaceRoot);
  const reviewDir = opts.reviewDir ?? defaultReviewDir(opts.workspaceRoot);
  if (opts.force === true) {
    try {
      await unlink(dbPath);
    } catch (err) {
      // ENOENT is expected (DB doesn't exist yet); anything else is an
      // operator error (EBUSY/EACCES) and must surface.
      if (!isMissingFsError(err)) throw err;
    }
  }
  const store = SqliteKnowledgeStore.openOrCreate({ dbPath });
  const review = new ReviewWriter({ outDir: reviewDir });
  const overrides = await loadMentionOverrides(reviewDir);

  let chunkCount = 0;
  let ambiguousMentions = 0;
  let fileCount = 0;
  let claimsCount = 0;
  let wikiPagesCount = 0;
  let llmClaimsResult: RunLlmClaimsPassResult | undefined;
  try {
    const files = await discoverHtmlFiles(opts.dataRoot);
    fileCount = files.length;

    for (const absPath of files) {
      const html = await readFile(absPath, "utf8");
      const sourceHash = sha1(html);
      const relPath = relative(opts.workspaceRoot, absPath).replace(/\\/g, "/");
      const existing = store.getDocumentByPath(relPath);
      if (existing !== undefined && existing.sourceHash === sourceHash) {
        continue; // unchanged — idempotent skip
      }
      const stats = await stat(absPath);
      const parsed = parseHtmlDocument(html);
      const kind = classifyDocumentKind(relPath);
      const docId = `doc:${sha1(relPath)}`;
      store.upsertDocument({
        id: docId,
        kind,
        title: parsed.title || relPath,
        path: relPath,
        url: parsed.url,
        sourceHash,
        sourceMtimeMs: stats.mtimeMs,
        createdAt: new Date().toISOString(),
      });

      const chunks = chunkParsedDocument(parsed, { documentId: docId });
      const labelInputs = chunks.map((c) => ({
        id: c.id,
        sectionPath: c.sectionPath,
        speaker: c.speaker,
        text: c.text,
        isDialogue: c.isDialogue,
      }));
      const labels = labelDocument({
        id: docId,
        path: relPath,
        title: parsed.title,
        chunks: labelInputs,
      });

      // Pass 1: insert all chunks so FK constraints are satisfied before LLM pass.
      for (const c of chunks) {
        const label = labels.find((l) => l.chunkId === c.id);
        const speakerMention = label?.mentions.find(
          (m) => m.speakerEntityId !== undefined,
        );
        const enrichedChunk = label
          ? {
              ...c,
              speakerEntityId: speakerMention?.speakerEntityId,
              isHertaVoiceEvidence: label.isHertaVoiceEvidence,
              isCanonFactCandidate: label.isCanonFactCandidate,
            }
          : c;
        store.insertChunk(enrichedChunk);
        chunkCount += 1;
      }

      const llmAnnotationsByChunkId =
        opts.llm !== undefined
          ? await runLlmPass(
              labels,
              chunks,
              kind,
              parsed.title,
              opts.llm,
              store,
            )
          : new Map<string, ReadonlyArray<LlmAnnotatedMention>>();

      // Pass 2: process mentions with LLM annotations (before) and operator overrides (after).
      for (const c of chunks) {
        const label = labels.find((l) => l.chunkId === c.id);
        if (label === undefined) continue;
        const llmAnnot = llmAnnotationsByChunkId.get(c.id);
        const afterLlm =
          llmAnnot === undefined
            ? label.mentions
            : applyLlmAnnotations(label.mentions, {
                chunkId: c.id,
                mentions: llmAnnot.map((m) => ({ ...m })),
                isHertaVoiceEvidence: label.isHertaVoiceEvidence,
              });
        const finalMentions = applyMentionOverrides(c.id, afterLlm, overrides);
        let mentionOrdinal = 0;
        for (const m of finalMentions) {
          const id = `${c.id}#m${mentionOrdinal++}`;
          store.insertMention({
            id,
            chunkId: c.id,
            surface: m.surface,
            startOffset: m.startOffset,
            endOffset: m.endOffset,
            referentEntityId: m.referentEntityId as CanonEntityId,
            embodimentEntityId: m.embodimentEntityId,
            speakerEntityId: m.speakerEntityId,
            pageSubjectEntityId: m.pageSubjectEntityId,
            confidence: m.confidence,
            method: m.method,
            rationale: m.rationale,
          });
          if (m.referentEntityId === HERTA_NAME_AMBIGUOUS) {
            ambiguousMentions += 1;
            review.recordAmbiguous({
              chunkId: c.id,
              path: relPath,
              title: parsed.title,
              sectionPath: c.sectionPath,
              speaker: c.speaker,
              text: c.text,
              candidate: {
                surface: m.surface,
                referentEntityId: m.referentEntityId as CanonEntityId,
                confidence: m.confidence,
                rationale: m.rationale,
              },
            });
          }
        }
      }
    }

    if (opts.extractClaims !== false) {
      const passResult = runExtractClaimsPass({
        store,
        now: new Date().toISOString(),
      });
      claimsCount = passResult.totalClaims;
    }
    if (opts.llmClaims !== undefined) {
      llmClaimsResult = await runLlmClaimsPass({
        store,
        now: new Date().toISOString(),
        llm: opts.llmClaims,
      });
      // Refresh: runLlmClaimsPass may have added or merged claims, so the
      // count from runExtractClaimsPass is now stale.
      claimsCount = store.countClaims();
    }
    if (opts.buildWiki !== false) {
      const wikiResult: RunWikiPagesPassResult = runWikiPagesPass({
        store,
        now: new Date().toISOString(),
      });
      wikiPagesCount = wikiResult.pagesWritten;
    }
  } finally {
    review.close();
    store.close();
  }
  return {
    fileCount,
    chunkCount,
    ambiguousMentions,
    claimsCount,
    llmClaims: llmClaimsResult,
    wikiPagesCount,
  };
}

async function discoverHtmlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, out);
  out.sort();
  return out;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // ENOENT is fine (a missing subdir is treated as empty); other errors
    // (EACCES, EIO, EBUSY) are operator problems and must surface.
    if (isMissingFsError(err)) return;
    throw err;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, out);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".html")) {
      out.push(full);
    }
  }
}

async function runLlmPass(
  labels: ReadonlyArray<import("./deterministic-labeler.js").LabelChunkResult>,
  chunks: ReadonlyArray<import("../schema.js").CanonChunk>,
  documentKind: import("../schema.js").CanonDocumentKind,
  documentTitle: string,
  llm: IngestLlmOptions,
  store: SqliteKnowledgeStore,
): Promise<Map<string, ReadonlyArray<LlmAnnotatedMention>>> {
  const candidates = selectLlmCandidates(labels, llm.maxChunks);
  if (candidates.length === 0) return new Map();
  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  const allowedIds = new Set(candidates.map((l) => l.chunkId));
  const out = new Map<string, ReadonlyArray<LlmAnnotatedMention>>();

  const slices: import("./deterministic-labeler.js").LabelChunkResult[][] = [];
  for (let i = 0; i < candidates.length; i += llm.concurrency) {
    slices.push(candidates.slice(i, i + llm.concurrency));
  }

  for (const slice of slices) {
    const promises = slice.map(async (label) => {
      const chunk = chunkById.get(label.chunkId);
      if (chunk === undefined) return;
      const req = buildDisambiguationRequest({
        model: llm.model,
        chunks: [
          {
            chunkId: chunk.id,
            documentTitle,
            documentKind,
            sectionPath: chunk.sectionPath,
            speaker: chunk.speaker,
            text: chunk.text,
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
          chunkId: chunk.id,
          provider: "deepseek",
          model: resp.model,
          task: "disambiguate_herta_mentions",
          inputHash,
          outputJson,
          createdAt: new Date().toISOString(),
        });
      }
      const validated = parseAndValidateLlmOutput(outputJson, allowedIds);
      for (const a of validated.accepted) {
        if (a.chunkId === chunk.id) out.set(chunk.id, a.mentions);
      }
    });
    await Promise.all(promises);
  }
  return out;
}
