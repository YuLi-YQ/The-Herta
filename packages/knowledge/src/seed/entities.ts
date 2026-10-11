import {
  HERTA_FORM_DOLL,
  HERTA_NAME_AMBIGUOUS,
  HERTA_PERSON_PRIME,
  HERTA_PLACE_SPACE_STATION,
  HERTA_WORK_MANUSCRIPT,
  type SeedEdge,
  type SeedEntity,
} from "../schema.js";

export const FACTION_GENIUS_SOCIETY = "faction.genius_society" as const;
export const PROJECT_SIMULATED_UNIVERSE = "project.simulated_universe" as const;
export const AEON_NOUS = "aeon.nous" as const;
export const PERSON_SCREWLLUM = "person.screwllum" as const;
export const PERSON_RUAN_MEI = "person.ruan_mei" as const;
export const PERSON_STEPHEN_LLOYD = "person.stephen_lloyd" as const;
/**
 * The player character, addressed by Herta in the CLI as the "user."
 * Single entity with two gender presentations (Stelle / Caelus) — both
 * are surface forms of the same character with identical dialogue trees,
 * so they're aliases of one entity rather than a prime/manifestation
 * split. "小家伙" is NOT a global alias here — it's Herta's verbal tell
 * for the player and will be surfaced by VoiceProfile extraction via
 * speaker context, not by global alias resolution.
 */
export const PERSON_TRAILBLAZER = "person.trailblazer" as const;

export const SEED_ENTITIES: ReadonlyArray<SeedEntity> = [
  {
    id: HERTA_PERSON_PRIME,
    type: "person",
    canonicalName: "大黑塔",
    description: "Genius Society #83. The real (prime) Herta.",
    aliases: [
      { alias: "大黑塔", lang: "zh", priority: 100 },
      { alias: "黑塔本人", lang: "zh", priority: 90 },
      { alias: "黑塔本体", lang: "zh", priority: 90 },
      { alias: "天才俱乐部#83", lang: "zh", priority: 80 },
      { alias: "Herta (prime)", lang: "en", priority: 50 },
    ],
  },
  {
    id: HERTA_FORM_DOLL,
    type: "manifestation",
    canonicalName: "小黑塔",
    description:
      "Remote doll / playable Herta. A manifestation operated by prime Herta.",
    aliases: [
      { alias: "小黑塔", lang: "zh", priority: 100 },
      { alias: "黑塔人偶", lang: "zh", priority: 90 },
      { alias: "黑塔（人偶）", lang: "zh", priority: 70 },
    ],
  },
  {
    id: HERTA_PLACE_SPACE_STATION,
    type: "place",
    canonicalName: "空间站「黑塔」",
    description: "The space station bearing Herta's name; not the person.",
    aliases: [
      { alias: "空间站「黑塔」", lang: "zh", priority: 100 },
      { alias: "「黑塔」空间站", lang: "zh", priority: 90 },
      { alias: "黑塔空间站", lang: "zh", priority: 80 },
      { alias: "Herta Space Station", lang: "en", priority: 50 },
    ],
  },
  {
    id: HERTA_WORK_MANUSCRIPT,
    type: "work",
    canonicalName: "黑塔的手稿",
    description: "Authored/attributed text(s) by prime Herta.",
    aliases: [{ alias: "黑塔的手稿", lang: "zh", priority: 100 }],
  },
  {
    id: HERTA_NAME_AMBIGUOUS,
    type: "ambiguous",
    canonicalName: "黑塔",
    description:
      "Sentinel for unresolved 黑塔 surface mentions. Never an edge endpoint.",
    aliases: [{ alias: "黑塔", lang: "zh", priority: 0 }],
  },
  {
    id: FACTION_GENIUS_SOCIETY,
    type: "faction",
    canonicalName: "天才俱乐部",
    aliases: [
      { alias: "天才俱乐部", lang: "zh", priority: 100 },
      { alias: "Genius Society", lang: "en", priority: 50 },
    ],
  },
  {
    id: PROJECT_SIMULATED_UNIVERSE,
    type: "project",
    canonicalName: "模拟宇宙",
    aliases: [
      { alias: "模拟宇宙", lang: "zh", priority: 100 },
      { alias: "Simulated Universe", lang: "en", priority: 50 },
    ],
  },
  {
    id: AEON_NOUS,
    type: "aeon",
    canonicalName: "博识尊",
    aliases: [
      { alias: "博识尊", lang: "zh", priority: 100 },
      { alias: "Nous", lang: "en", priority: 50 },
    ],
  },
  {
    id: PERSON_SCREWLLUM,
    type: "person",
    canonicalName: "螺丝咕姆",
    aliases: [
      { alias: "螺丝咕姆", lang: "zh", priority: 100 },
      { alias: "Screwllum", lang: "en", priority: 50 },
    ],
  },
  {
    id: PERSON_RUAN_MEI,
    type: "person",
    canonicalName: "阮•梅",
    aliases: [
      { alias: "阮•梅", lang: "zh", priority: 100 },
      { alias: "阮梅", lang: "zh", priority: 80 },
      { alias: "Ruan Mei", lang: "en", priority: 50 },
    ],
  },
  {
    id: PERSON_STEPHEN_LLOYD,
    type: "person",
    canonicalName: "斯蒂芬·罗伊德",
    aliases: [
      { alias: "斯蒂芬·罗伊德", lang: "zh", priority: 100 },
      { alias: "Stephen Lloyd", lang: "en", priority: 50 },
    ],
  },
  {
    id: PERSON_TRAILBLAZER,
    type: "person",
    canonicalName: "开拓者",
    description:
      "The player character. Addressed by the user at the CLI keyboard. Two gender presentations (Stelle / Caelus) share one canonical entity.",
    aliases: [
      { alias: "开拓者", lang: "zh", priority: 100 },
      { alias: "星", lang: "zh", priority: 90 },
      { alias: "穹", lang: "zh", priority: 90 },
      { alias: "Trailblazer", lang: "en", priority: 50 },
      { alias: "Stelle", lang: "en", priority: 40 },
      { alias: "Caelus", lang: "en", priority: 40 },
    ],
  },
];

export const SEED_EDGES: ReadonlyArray<SeedEdge> = [
  {
    sourceEntityId: HERTA_FORM_DOLL,
    relation: "manifestation_of",
    targetEntityId: HERTA_PERSON_PRIME,
    rationale: "Spec §7.3 seed.",
  },
  {
    sourceEntityId: HERTA_PERSON_PRIME,
    relation: "controls_or_uses",
    targetEntityId: HERTA_FORM_DOLL,
    rationale: "Spec §7.3 seed.",
  },
  {
    sourceEntityId: HERTA_PERSON_PRIME,
    relation: "owns",
    targetEntityId: HERTA_PLACE_SPACE_STATION,
    rationale: "Spec §7.3 seed.",
  },
  {
    sourceEntityId: HERTA_WORK_MANUSCRIPT,
    relation: "authored",
    targetEntityId: HERTA_PERSON_PRIME,
    rationale: "Spec §7.3 seed.",
  },
  {
    sourceEntityId: HERTA_PERSON_PRIME,
    relation: "member_of",
    targetEntityId: FACTION_GENIUS_SOCIETY,
    rationale: "Spec §7.3 seed.",
  },
  {
    sourceEntityId: HERTA_PERSON_PRIME,
    relation: "associated_with",
    targetEntityId: PROJECT_SIMULATED_UNIVERSE,
    rationale: "Spec §7.3 seed.",
  },
];
