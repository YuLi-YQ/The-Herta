import * as fs from "node:fs";
import * as path from "node:path";
import type { HertaSelfModelV1 } from "./schema.js";

export type ProgrammaticCheckFailure =
  | {
      kind: "banned_phrase";
      slot: string;
      phrase: string;
      pattern: string;
    }
  | {
      kind: "third_person_voice";
      slot: string;
      sample: string;
    }
  | {
      kind: "ni_hao_opener";
      slot: string;
      sample: string;
    }
  | {
      kind: "evidence_unresolved";
      slot: string;
      filename: string;
    };

export interface ProgrammaticChecksInput {
  selfModel: HertaSelfModelV1;
  /**
   * Directory to walk recursively for evidence-resolution. Used when
   * `sourceFiles` is not provided.
   */
  corpusRoot?: string;
  /**
   * Override set of accepted source filenames (basenames). Bypasses fs
   * walk when provided. Useful for tests.
   */
  sourceFiles?: ReadonlySet<string>;
}

export interface ProgrammaticChecksResult {
  passed: boolean;
  failures: ProgrammaticCheckFailure[];
}

const BANNED_PHRASES: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /Herta CLI 这个文字通道/, label: "Herta CLI 这个文字通道" },
  { pattern: /(?:^|[^一-鿿])文字通道/, label: "文字通道" },
  { pattern: /is your current form/i, label: "is your current form" },
  { pattern: /your current form/i, label: "your current form" },
  { pattern: /terminal embodiment/i, label: "terminal embodiment" },
  { pattern: /I am (?:the )?Herta CLI/i, label: "I am Herta CLI" },
  { pattern: /我是 Herta CLI/i, label: "我是 Herta CLI" },
  // Typing-delegation regression: the terminal channel is Herta's *own*
  // typing. Even if canon mentions 小黑塔/数字版, they don't sit between
  // her and the user on this channel.
  {
    pattern:
      /(?:数字助手|小黑塔|数字版|AI\s*助理|聊天程序)[^。；！？\n]{0,20}(?:替我|代我|帮我)[^。；！？\n]{0,10}(?:打字|开口|应付|回话|回复|聊)/,
    label: "数字助手/小黑塔 替我打字 (typing-delegation)",
  },
  {
    pattern:
      /让[^。；！？\n]{0,15}(?:替我|代我)[^。；！？\n]{0,10}(?:打字|开口|应付|回话|回复)/,
    label: "让 ___ 替我打字 (typing-delegation)",
  },
];

const THIRD_PERSON_PATTERN = /\b(?:Herta|She)\s+(?:is|does|has|works|lives)\b/;

/**
 * Run all programmatic checks against a synthesized self-model. Failures
 * are HARD — Pass 4 (DB ingest) is gated on `passed === true`. Use the
 * separate `parseSynthesisOutput` validator for SOFT warnings.
 *
 * Checks:
 *  1. Banned-phrase regression: no `Herta CLI 这个文字通道`, no `is your
 *     current form`, no CLI-as-self framings anywhere in prose.
 *  2. Third-person voice: prose in first-person slots must not use
 *     `Herta is` / `She is`.
 *  3. 你好 opener: biography / interaction_register prose must not OPEN
 *     with `你好`.
 *  4. Evidence resolution: every cited filename in key_facts /
 *     relationships / anti_patterns must exist in the corpus.
 */
export function runProgrammaticChecks(
  input: ProgrammaticChecksInput,
): ProgrammaticChecksResult {
  const failures: ProgrammaticCheckFailure[] = [];

  const proseSlots: ReadonlyArray<{ slot: string; prose: string }> = [
    { slot: "biography", prose: input.selfModel.biography.prose },
    { slot: "philosophy", prose: input.selfModel.philosophy.prose },
    { slot: "embodiment", prose: input.selfModel.embodiment.prose },
    {
      slot: "harness_proprioception",
      prose: input.selfModel.harness_proprioception.prose,
    },
    {
      slot: "interaction_register",
      prose: input.selfModel.interaction_register.prose,
    },
    ...Object.entries(input.selfModel.relationships).map(([id, r]) => ({
      slot: `relationships.${id}`,
      prose: r.prose,
    })),
  ];

  // 1. Banned-phrase scan across every prose slot.
  for (const { slot, prose } of proseSlots) {
    for (const { pattern, label } of BANNED_PHRASES) {
      const m = pattern.exec(prose);
      if (m !== null) {
        failures.push({
          kind: "banned_phrase",
          slot,
          phrase: label,
          pattern: pattern.toString(),
        });
      }
    }
  }

  // 2. Third-person voice in first-person slots.
  for (const { slot, prose } of proseSlots) {
    const m = THIRD_PERSON_PATTERN.exec(prose);
    if (m !== null) {
      failures.push({
        kind: "third_person_voice",
        slot,
        sample: m[0],
      });
    }
  }

  // 3. 你好 opener on biography + interaction_register.
  const niHaoSlots = [
    { slot: "biography", prose: input.selfModel.biography.prose },
    {
      slot: "interaction_register",
      prose: input.selfModel.interaction_register.prose,
    },
  ];
  for (const { slot, prose } of niHaoSlots) {
    if (/^\s*你好/.test(prose)) {
      failures.push({
        kind: "ni_hao_opener",
        slot,
        sample: prose.slice(0, 30),
      });
    }
  }

  // 4. Evidence resolution.
  const sourceFiles = input.sourceFiles ?? collectSourceFiles(input.corpusRoot);
  if (sourceFiles !== null) {
    for (const ev of collectEvidence(input.selfModel)) {
      if (!sourceFiles.has(ev.filename)) {
        failures.push({
          kind: "evidence_unresolved",
          slot: ev.slot,
          filename: ev.filename,
        });
      }
    }
  }

  return { passed: failures.length === 0, failures };
}

interface EvidenceRef {
  slot: string;
  filename: string;
}

function* collectEvidence(selfModel: HertaSelfModelV1): Generator<EvidenceRef> {
  for (const slot of [
    "biography",
    "philosophy",
    "embodiment",
    "harness_proprioception",
  ] as const) {
    for (const kf of selfModel[slot].key_facts) {
      for (const filename of kf.evidence) {
        yield { slot, filename };
      }
    }
  }
  for (const [id, r] of Object.entries(selfModel.relationships)) {
    for (const filename of r.evidence) {
      yield { slot: `relationships.${id}`, filename };
    }
  }
  for (const [i, ap] of selfModel.anti_patterns.entries()) {
    for (const filename of ap.evidence) {
      yield { slot: `anti_patterns[${i}]`, filename };
    }
  }
}

function collectSourceFiles(
  corpusRoot: string | undefined,
): ReadonlySet<string> | null {
  if (corpusRoot === undefined) return null;
  const set = new Set<string>();
  for (const file of walk(corpusRoot)) {
    set.add(path.basename(file));
  }
  return set;
}

function* walk(root: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}
