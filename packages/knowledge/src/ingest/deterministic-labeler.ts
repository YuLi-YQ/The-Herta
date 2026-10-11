import {
  type CanonEntityId,
  type EntityMention,
  HERTA_FORM_DOLL,
  HERTA_NAME_AMBIGUOUS,
  HERTA_PERSON_PRIME,
  HERTA_PLACE_SPACE_STATION,
  HERTA_WORK_MANUSCRIPT,
} from "../schema.js";

export interface LabelChunkInput {
  id: string;
  sectionPath: readonly string[];
  speaker: string | undefined;
  text: string;
  isDialogue: boolean;
}

export interface LabelDocumentInput {
  id: string;
  path: string;
  title: string;
  chunks: ReadonlyArray<LabelChunkInput>;
}

export interface LabelChunkResult {
  chunkId: string;
  pageSubjectEntityId?: CanonEntityId;
  isHertaVoiceEvidence: boolean;
  isCanonFactCandidate: boolean;
  mentions: Array<Omit<EntityMention, "id" | "chunkId">>;
}

export function pageSubjectFor(
  path: string,
  title: string,
): CanonEntityId | undefined {
  const norm = path.replace(/\\/g, "/");
  if (/角色图鉴\/\d+_大黑塔\.html$/.test(norm)) return HERTA_PERSON_PRIME;
  if (/角色图鉴\/\d+_黑塔\.html$/.test(norm)) return HERTA_FORM_DOLL;
  // 角色语音 (VO atlas, scraped 2026-08-31) mirrors the 图鉴 split: the
  // 大黑塔 page is the prime speaking, the 黑塔 page the doll form.
  if (/角色语音\/\d+_大黑塔\.html$/.test(norm)) return HERTA_PERSON_PRIME;
  if (/角色语音\/\d+_黑塔\.html$/.test(norm)) return HERTA_FORM_DOLL;
  if (norm.includes("空间站「黑塔」")) return HERTA_PLACE_SPACE_STATION;
  // Phase 2A: book/lore titles using corner-bracket 「黑塔」 (without 空间站
  // prefix) or 黑塔藏品间 are station-asset references in real corpus.
  if (title.includes("「黑塔」") || title.includes("黑塔藏品间"))
    return HERTA_PLACE_SPACE_STATION;
  if (norm.includes("黑塔的手稿") || title.includes("黑塔的手稿"))
    return HERTA_WORK_MANUSCRIPT;
  if (title.includes("大黑塔")) return HERTA_PERSON_PRIME;
  return undefined;
}

const DOLL_KEYWORDS = ["人偶", "远程操纵", "（小）"] as const;
const PRIME_COUNTER_KEYWORDS = ["本体", "本人", "真身"] as const;

// Compound surfaces that are themselves resolved by the high-confidence
// surface block. The bare-黑塔 fallback must skip when one of these has
// already been emitted; keeping the list in one place prevents drift.
const COMPOUND_HERTA_SURFACES = [
  "空间站「黑塔」",
  "「黑塔」",
  "大黑塔",
  "黑塔本人",
  "黑塔本体",
  "小黑塔",
  "黑塔人偶",
] as const;

// Deterministic-labeler confidence values. Phase 2 (LLM labeling) may
// compare or override these; keep them named so future tuning has one
// place to look.
const CONF_HIGH_SURFACE = 0.99; // 空间站「黑塔」, 大黑塔, 黑塔本人, 黑塔本体
const CONF_DOLL_SURFACE = 0.95; // 小黑塔, 黑塔人偶
const CONF_BRACKET_STATION = 0.85; // 「黑塔」 in text without 空间站 prefix
const CONF_SPEAKER = 0.85; // speaker-label resolution
const CONF_PRIOR = 0.7; // page-subject prior for bare 黑塔
const CONF_AMBIGUOUS = 0.55; // both signals fire OR no signal at all

// Window (in code units) used by `nearby` proximity matching. ~80 code
// units ≈ 40-80 CJK chars, i.e. 2-4 sentences.
const NEARBY_WINDOW = 80;

function nearby(
  text: string,
  kw: string,
  target: string,
  window: number,
): boolean {
  const idx = text.indexOf(target);
  if (idx === -1) return false;
  const start = Math.max(0, idx - window);
  const end = Math.min(text.length, idx + target.length + window);
  return text.substring(start, end).includes(kw);
}

function dollSignals(
  text: string,
  sectionPath: readonly string[],
  path: string,
  speakerIsHerta: boolean,
): boolean {
  const inDollProfile = /角色图鉴\/\d+_黑塔\.html$/.test(
    path.replace(/\\/g, "/"),
  );
  if (inDollProfile) return true;
  const inSimUniverse = path.includes("/plot_html/模拟宇宙/");
  if (inSimUniverse) return true;
  for (const kw of DOLL_KEYWORDS) {
    // When the speaker is already "黑塔", doll keywords anywhere in the text are sufficient.
    if (
      speakerIsHerta
        ? text.includes(kw)
        : nearby(text, kw, "黑塔", NEARBY_WINDOW)
    )
      return true;
  }
  for (const seg of sectionPath) {
    if (
      seg.includes("空间站「黑塔」") ||
      seg.includes("藏品间") ||
      seg.includes("人偶")
    )
      return true;
  }
  return false;
}

function primeCounterSignals(text: string): boolean {
  for (const kw of PRIME_COUNTER_KEYWORDS) {
    if (nearby(text, kw, "黑塔", NEARBY_WINDOW)) return true;
  }
  return false;
}

export function labelDocument(input: LabelDocumentInput): LabelChunkResult[] {
  const pageSubject = pageSubjectFor(input.path, input.title);
  const out: LabelChunkResult[] = [];
  for (const chunk of input.chunks) {
    const mentions: LabelChunkResult["mentions"] = [];
    let isHertaVoiceEvidence = false;
    let isCanonFactCandidate = false;

    // High-confidence multi-character surfaces first.
    if (chunk.text.includes("空间站「黑塔」")) {
      mentions.push({
        surface: "空间站「黑塔」",
        referentEntityId: HERTA_PLACE_SPACE_STATION,
        pageSubjectEntityId: pageSubject,
        confidence: CONF_HIGH_SURFACE,
        method: "deterministic",
      });
    }
    // Phase 2A: 「黑塔」 (no 空间站 prefix) in text is usually the station,
    // unless prime-counter signals (本人/本体/真身) suggest emphasis-of-person.
    // Skip if 空间站「黑塔」 already matched (its substring covers 「黑塔」).
    if (
      chunk.text.includes("「黑塔」") &&
      !chunk.text.includes("空间站「黑塔」") &&
      !primeCounterSignals(chunk.text)
    ) {
      mentions.push({
        surface: "「黑塔」",
        referentEntityId: HERTA_PLACE_SPACE_STATION,
        pageSubjectEntityId: pageSubject,
        confidence: CONF_BRACKET_STATION,
        method: "deterministic",
        rationale:
          "Corner-bracket 「黑塔」 in text without 空间站 prefix; no prime-counter signals.",
      });
    }
    const primeSurface = firstSurface(chunk.text, [
      "大黑塔",
      "黑塔本人",
      "黑塔本体",
    ]);
    if (primeSurface !== undefined) {
      mentions.push({
        surface: primeSurface,
        referentEntityId: HERTA_PERSON_PRIME,
        pageSubjectEntityId: pageSubject,
        confidence: CONF_HIGH_SURFACE,
        method: "deterministic",
      });
      isCanonFactCandidate = true;
    }
    const dollSurface = firstSurface(chunk.text, ["小黑塔", "黑塔人偶"]);
    if (dollSurface !== undefined) {
      mentions.push({
        surface: dollSurface,
        referentEntityId: HERTA_FORM_DOLL,
        pageSubjectEntityId: pageSubject,
        confidence: CONF_DOLL_SURFACE,
        method: "deterministic",
      });
    }

    // Speaker label "大黑塔" in mission dialogue (the 3.x arcs credit the
    // playable prime this way): unambiguous prime, no doll checks — the
    // compound surface can never mean the doll or the station. Found as an
    // alias gap 2026-08-31: these turns carried no speakerEntityId, so
    // scene extraction filed the「何为神性」lines under otherSpeakers.
    if (chunk.isDialogue && chunk.speaker === "大黑塔") {
      mentions.push({
        surface: "大黑塔",
        referentEntityId: HERTA_PERSON_PRIME,
        speakerEntityId: HERTA_PERSON_PRIME,
        pageSubjectEntityId: pageSubject,
        confidence: CONF_HIGH_SURFACE,
        method: "deterministic",
        rationale: "Mission speaker label 大黑塔 — unambiguous prime surface.",
      });
      isHertaVoiceEvidence = true;
    }

    // Speaker label "黑塔" in mission dialogue.
    if (chunk.isDialogue && chunk.speaker === "黑塔") {
      const dollEmbodiment = dollSignals(
        chunk.text,
        chunk.sectionPath,
        input.path,
        true,
      );
      const counter = primeCounterSignals(chunk.text);
      const ambiguous = dollEmbodiment && counter;
      if (ambiguous) {
        mentions.push({
          surface: "黑塔",
          referentEntityId: HERTA_NAME_AMBIGUOUS,
          pageSubjectEntityId: pageSubject,
          confidence: CONF_AMBIGUOUS,
          method: "deterministic",
          rationale:
            "Speaker '黑塔' with both doll-embodiment and prime-counter signals.",
        });
      } else {
        mentions.push({
          surface: "黑塔",
          referentEntityId: HERTA_PERSON_PRIME,
          embodimentEntityId: dollEmbodiment ? HERTA_FORM_DOLL : undefined,
          speakerEntityId: HERTA_PERSON_PRIME,
          pageSubjectEntityId: pageSubject,
          confidence: CONF_SPEAKER,
          method: "deterministic",
          rationale: dollEmbodiment
            ? "Mission speaker label, doll-embodiment signal."
            : "Mission speaker label, no doll signal — prime-form default.",
        });
        isHertaVoiceEvidence = true;
      }
    } else if (
      chunk.text.includes("黑塔") &&
      !alreadyResolvedHertaSurface(mentions)
    ) {
      // Bare 黑塔 outside dialogue — fall back to page-subject prior.
      const referent =
        pageSubject === HERTA_FORM_DOLL ||
        pageSubject === HERTA_PERSON_PRIME ||
        pageSubject === HERTA_PLACE_SPACE_STATION ||
        pageSubject === HERTA_WORK_MANUSCRIPT
          ? pageSubject
          : HERTA_NAME_AMBIGUOUS;
      const confidence =
        referent === HERTA_NAME_AMBIGUOUS ? CONF_AMBIGUOUS : CONF_PRIOR;
      mentions.push({
        surface: "黑塔",
        referentEntityId: referent,
        pageSubjectEntityId: pageSubject,
        confidence,
        method: "deterministic",
        rationale:
          referent === HERTA_NAME_AMBIGUOUS
            ? "Bare 黑塔 with no contextual or page signal."
            : "Bare 黑塔 resolved via page-subject prior.",
      });
    }

    out.push({
      chunkId: chunk.id,
      pageSubjectEntityId: pageSubject,
      isHertaVoiceEvidence,
      isCanonFactCandidate,
      mentions,
    });
  }
  return out;
}

function firstSurface(
  text: string,
  candidates: ReadonlyArray<string>,
): string | undefined {
  for (const c of candidates) {
    if (text.includes(c)) return c;
  }
  return undefined;
}

function alreadyResolvedHertaSurface(
  mentions: ReadonlyArray<{ surface: string }>,
): boolean {
  return mentions.some((m) =>
    (COMPOUND_HERTA_SURFACES as ReadonlyArray<string>).includes(m.surface),
  );
}
