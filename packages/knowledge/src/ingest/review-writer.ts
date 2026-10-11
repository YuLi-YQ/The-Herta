import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REVIEW_AMBIGUOUS_FILENAME } from "../paths.js";
import type { CanonEntityId } from "../schema.js";

export interface ReviewWriterOpts {
  outDir: string;
}

export interface AmbiguousRecord {
  chunkId: string;
  path: string;
  title: string;
  sectionPath: string[];
  speaker?: string;
  text: string;
  candidate: {
    surface: string;
    referentEntityId: CanonEntityId;
    confidence: number;
    rationale?: string;
  };
}

export class ReviewWriter {
  private readonly ambiguousPath: string;
  private opened = false;

  constructor(opts: ReviewWriterOpts) {
    mkdirSync(opts.outDir, { recursive: true });
    this.ambiguousPath = join(opts.outDir, REVIEW_AMBIGUOUS_FILENAME);
  }

  recordAmbiguous(rec: AmbiguousRecord): void {
    if (!this.opened) {
      writeFileSync(this.ambiguousPath, "");
      this.opened = true;
    }
    const line = JSON.stringify({
      chunk_id: rec.chunkId,
      path: rec.path,
      title: rec.title,
      section_path: rec.sectionPath,
      speaker: rec.speaker ?? null,
      text: rec.text,
      candidate_mentions: [
        {
          surface: rec.candidate.surface,
          referent_entity_id: rec.candidate.referentEntityId,
          confidence: rec.candidate.confidence,
          rationale: rec.candidate.rationale ?? null,
        },
      ],
    });
    appendFileSync(this.ambiguousPath, `${line}\n`);
  }

  close(): void {
    // No-op for this writer; the file handle is per-call. Reserved for future buffering.
  }
}
