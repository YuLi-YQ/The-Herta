import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMissingFsError } from "../fs-utils.js";
import { OVERRIDES_FILENAME } from "../paths.js";
import type { CanonEntityId } from "../schema.js";

export interface MentionOverride {
  chunkId: string;
  surface: string;
  referentEntityId: CanonEntityId;
  embodimentEntityId?: CanonEntityId;
  speakerEntityId?: CanonEntityId;
  confidence: number;
  note?: string;
}

interface RawOverride {
  target_type?: unknown;
  chunk_id?: unknown;
  surface?: unknown;
  referent_entity_id?: unknown;
  embodiment_entity_id?: unknown;
  speaker_entity_id?: unknown;
  confidence?: unknown;
  note?: unknown;
}

export async function loadMentionOverrides(
  reviewDir: string,
): Promise<MentionOverride[]> {
  const path = join(reviewDir, OVERRIDES_FILENAME);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (err) {
    if (isMissingFsError(err)) return [];
    throw err;
  }

  const out: MentionOverride[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let raw: RawOverride;
    try {
      raw = JSON.parse(trimmed) as RawOverride;
    } catch {
      continue;
    }
    const parsed = parseMentionOverride(raw);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

function parseMentionOverride(raw: RawOverride): MentionOverride | undefined {
  if (raw.target_type !== "mention") return undefined;
  if (typeof raw.chunk_id !== "string") return undefined;
  if (typeof raw.surface !== "string") return undefined;
  if (typeof raw.referent_entity_id !== "string") return undefined;
  if (typeof raw.confidence !== "number") return undefined;
  return {
    chunkId: raw.chunk_id,
    surface: raw.surface,
    referentEntityId: raw.referent_entity_id,
    embodimentEntityId:
      typeof raw.embodiment_entity_id === "string"
        ? raw.embodiment_entity_id
        : undefined,
    speakerEntityId:
      typeof raw.speaker_entity_id === "string"
        ? raw.speaker_entity_id
        : undefined,
    confidence: raw.confidence,
    note: typeof raw.note === "string" ? raw.note : undefined,
  };
}
