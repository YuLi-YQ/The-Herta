import type { TerminalRecord } from "@herta/app-server";

/**
 * Mock conversation matching the reference image. The conversation
 * ends mid-turn (no final Herta reply) so that the consuming
 * useActiveSession() hook can return status: "thinking" and the
 * GalaxyTravelRow renders at the bottom of the conversation.
 */
export const mockRecord: TerminalRecord = [
  {
    kind: "user",
    text: "Can you analyze the latest discovery from the outer rim?",
  },
  {
    kind: "herta",
    surface: "speech",
    text:
      "Certainly, Herta Prime. The readings indicate unusual quantum " +
      "fluctuations consistent with a localized spacetime anomaly.",
  },
  {
    kind: "user",
    text: "What are the potential implications?",
  },
];

/**
 * Empty record for sessions other than today-1 in Slice 3.
 */
export const mockEmptyRecord: TerminalRecord = [];
