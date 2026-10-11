import type { EntityMention } from "../schema.js";
import type { MentionOverride } from "./override-loader.js";

type MentionShape = Omit<EntityMention, "id" | "chunkId">;

export function applyMentionOverrides(
  chunkId: string,
  mentions: ReadonlyArray<MentionShape>,
  overrides: ReadonlyArray<MentionOverride>,
): MentionShape[] {
  const relevant = overrides.filter((o) => o.chunkId === chunkId);
  if (relevant.length === 0) return [...mentions];
  return mentions.map((m) => {
    let result = m;
    for (const o of relevant) {
      if (o.surface !== m.surface) continue;
      result = {
        ...result,
        referentEntityId: o.referentEntityId,
        embodimentEntityId: o.embodimentEntityId ?? result.embodimentEntityId,
        speakerEntityId: o.speakerEntityId ?? result.speakerEntityId,
        confidence: o.confidence,
        method: "human_review",
        rationale: o.note ?? "Operator override.",
      };
    }
    return result;
  });
}
