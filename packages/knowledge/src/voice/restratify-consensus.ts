import type { Mood, RegisterMode, StratumSource } from "../schema.js";
import type {
  AddresseeClass,
  RestratifyClassification,
} from "./restratify-output-validator.js";

export interface ConsensusReducedRow {
  addressee_class: AddresseeClass;
  addressee_entity_id?: string;
  addressee_entity_id_llm?: string;
  mood?: Mood;
  register_mode?: RegisterMode;
  grounded_citation: string;
  confidence: number;
  source: StratumSource;
  disagreement_with_heuristic: boolean;
  pass_a_verdict_json: string;
  pass_b_verdict_json: string;
}

export function reduceConsensus(
  a: RestratifyClassification,
  b: RestratifyClassification,
): ConsensusReducedRow {
  const classMatch = a.addressee_class === b.addressee_class;
  const entityMatch =
    (a.addressee_entity_id ?? null) === (b.addressee_entity_id ?? null);
  const consensus = classMatch && entityMatch;

  if (consensus) {
    const moodMatch = a.mood === b.mood;
    const modeMatch = a.register_mode === b.register_mode;
    return {
      addressee_class: a.addressee_class,
      addressee_entity_id: a.addressee_entity_id,
      addressee_entity_id_llm: a.addressee_entity_id,
      mood: moodMatch ? a.mood : undefined,
      register_mode: modeMatch ? a.register_mode : undefined,
      grounded_citation: a.grounded_citation,
      confidence: 0.9,
      source: "consensus",
      disagreement_with_heuristic: false,
      pass_a_verdict_json: JSON.stringify(a),
      pass_b_verdict_json: JSON.stringify(b),
    };
  }
  return {
    addressee_class: "unknown",
    addressee_entity_id: undefined,
    addressee_entity_id_llm: undefined,
    mood: undefined,
    register_mode: undefined,
    grounded_citation: "",
    confidence: 0.2,
    source: "disagreement",
    disagreement_with_heuristic: false,
    pass_a_verdict_json: JSON.stringify(a),
    pass_b_verdict_json: JSON.stringify(b),
  };
}
