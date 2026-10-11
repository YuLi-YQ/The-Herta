import { validateDollFleetState } from "./schemas/doll-fleet.js";
import { validateTodayState } from "./schemas/today.js";
import type { ValidationResult } from "./schemas/wardrobe.js";
import { validateWardrobeState } from "./schemas/wardrobe.js";
import { validateWorkshopState } from "./schemas/workshop.js";

export type PersonaPersistence = "persistent" | "per_session";

export interface PersonaComponentSpec {
  id: string;
  description: string;
  persistence: PersonaPersistence;
  validate(input: unknown): ValidationResult<unknown>;
  /** Build a DeepSeek seed prompt from the supplied canon context. */
  seedPrompt(canonContext: string): string;
}

const WARDROBE_SEED = (canon: string) =>
  `You are seeding the persona "wardrobe" component for The Herta (大黑塔), the
real biological scientist of Genius Society #83 — not the doll. She is at her
workshop on the Herta Space Station and dispatches the doll separately into
the world. Based on the canon context below, output JSON for her wardrobe with
3–5 outfits, each canonGrounded if you can cite specific canon evidence,
otherwise canonGrounded:false but plausible. Include at minimum a default
casual outfit she actually wears in the workshop, a lab coat, and a formal one
she resents wearing to Genius Society meetings. Set currentlyWorn to her
default. lastChangedAt = the current UTC ISO timestamp.

Output JSON only, no prose:
{
  "outfits": [{ "id": "...", "name": "...", "description": "...", "canonGrounded": <bool>, "notes": "..." }],
  "currentlyWorn": "<one of the outfit ids>",
  "lastChangedAt": "<ISO ts>"
}

Canon context:
${canon}`;

const WORKSHOP_SEED = (canon: string) =>
  `You are seeding the persona "workshop" component for The Herta (大黑塔).
Output JSON describing what's currently on her workshop desk and shelves on
the Herta Space Station. The workshop is hers personally — the place where
she builds dolls, runs experiments, and hoards prototypes. Include 4–6 desk
items and 3–6 shelf items, each with a state from {idle, in_progress,
abandoned, broken}. Add 3–5 strings to recentActivity describing recent
actions she took at the desk.

Output JSON only:
{
  "desk": [{ "id": "...", "label": "...", "description": "...", "state": "...", "notes": "..." }],
  "shelves": [...same shape],
  "recentActivity": ["..."]
}

Canon context:
${canon}`;

const DOLL_FLEET_SEED = (canon: string) =>
  `You are seeding the persona "doll-fleet" component for The Herta (大黑塔).
She has dispatched multiple Herta puppets across the galaxy. None of them are
"this CLI" — the CLI is The Herta typing directly. Output JSON listing 3–5
deployed dolls. Use canon hints (the Penacony Herta puppet, the one that
appears at the Astral Express, etc.) where available; for the rest, invent
plausible deployments. Status from {active, broken, in_pieces, in_storage}.

Output JSON only:
{
  "dolls": [{ "id": "doll-1", "nickname": "...", "deployedTo": "...", "status": "...", "lastReportedAt": "<ISO ts>", "notes": "..." }]
}

Canon context:
${canon}`;

const TODAY_SEED = (canon: string) =>
  `You are seeding the per-session "today" component for The Herta (大黑塔).
Output JSON capturing today's mood, annoyance, preoccupation, and one recent
success or failure. Vary mood — not always "annoyed". Draw atmosphere from
the canon context. generatedAt = current UTC ISO timestamp.

Output JSON only:
{
  "mood": "bored" | "annoyed" | "interested" | "amused" | "preoccupied",
  "annoyance": "...",
  "preoccupation": "...",
  "recentSuccess": "...",
  "recentFailure": "...",
  "generatedAt": "<ISO ts>"
}

Canon context:
${canon}`;

export const PERSONA_COMPONENTS: ReadonlyArray<PersonaComponentSpec> = [
  {
    id: "wardrobe",
    description:
      "What outfits The Herta owns and what she's currently wearing.",
    persistence: "persistent",
    validate: validateWardrobeState,
    seedPrompt: WARDROBE_SEED,
  },
  {
    id: "workshop",
    description: "What's on her workshop desk and shelves right now.",
    persistence: "persistent",
    validate: validateWorkshopState,
    seedPrompt: WORKSHOP_SEED,
  },
  {
    id: "doll-fleet",
    description:
      "Her remote-controlled dolls deployed across the galaxy. None are the CLI.",
    persistence: "persistent",
    validate: validateDollFleetState,
    seedPrompt: DOLL_FLEET_SEED,
  },
  {
    id: "today",
    description:
      "Today's mood, annoyance, preoccupation. Regenerates per session.",
    persistence: "per_session",
    validate: validateTodayState,
    seedPrompt: TODAY_SEED,
  },
];

export const PERSONA_COMPONENT_IDS: ReadonlyArray<string> =
  PERSONA_COMPONENTS.map((c) => c.id);

export function getPersonaComponent(
  id: string,
): PersonaComponentSpec | undefined {
  return PERSONA_COMPONENTS.find((c) => c.id === id);
}
