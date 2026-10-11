import * as fs from "node:fs/promises";
import * as path from "node:path";
import { grepCorpusForHerta } from "./corpus-grep.js";
import {
  type CorpusCandidate,
  type CorpusManifest,
  corpusManifestSchema,
} from "./schema.js";

export interface ExpandCorpusInput {
  /** Root of the canon corpus (e.g., `data/`). */
  corpusRoot: string;
  /** Where to write the manifest. Parent directories will be created. */
  manifestPath: string;
}

/**
 * Pass 0.5 runner. Greps the corpus for Herta mentions; merges results
 * with any existing manifest's `accepted` flags (so a human's review
 * decisions persist across re-runs); writes the merged manifest.
 *
 * Returns the new manifest for in-process use.
 */
export async function runExpandCorpusPass(
  input: ExpandCorpusInput,
): Promise<CorpusManifest> {
  await fs.mkdir(path.dirname(input.manifestPath), { recursive: true });

  const fresh = await grepCorpusForHerta({ root: input.corpusRoot });
  const previousAccepted = await readPreviousAccepted(input.manifestPath);

  const merged: CorpusCandidate[] = fresh.map((c) => ({
    ...c,
    accepted: previousAccepted.get(c.path) ?? c.accepted,
  }));

  const manifest: CorpusManifest = {
    version: 1,
    candidates: merged,
  };

  await fs.writeFile(
    input.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  return manifest;
}

async function readPreviousAccepted(
  manifestPath: string,
): Promise<Map<string, boolean>> {
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = corpusManifestSchema.parse(JSON.parse(raw));
    const m = new Map<string, boolean>();
    for (const c of parsed.candidates) m.set(c.path, c.accepted);
    return m;
  } catch {
    return new Map();
  }
}
