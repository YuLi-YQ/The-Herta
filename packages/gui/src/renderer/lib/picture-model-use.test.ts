import type { RoundPicture, RoundSummary } from "@herta/app-server";
import { describe, expect, it } from "vitest";
import { latestPictureResults, pictureRowOf } from "./picture-model-use.js";

const round = (
  recordStart: number,
  pictures?: { persona?: RoundPicture[]; executor?: RoundPicture[] },
): RoundSummary => ({
  schemaVersion: 1,
  id: `round-${recordStart}`,
  sessionId: "s",
  attemptIds: [],
  recordStart,
  startedAt: "2026-10-30T00:00:00Z",
  endedAt: null,
  durationMs: null,
  status: "completed",
  files: [],
  activities: [],
  metrics: {
    totalTokens: null,
    cacheHitRate: null,
    outputTokensPerSecond: null,
    contextUsed: null,
    contextWindow: null,
    partial: true,
  },
  limitations: [],
  ...(pictures ? { pictures } : {}),
});
const A = ".herta/attachments/s/a.png";
const B = ".herta/attachments/s/b.png";

describe("pictureRowOf (F04, R116): the rows the session accepts", () => {
  it("takes a picture with a stored copy, stopped or not, as the session's imageRowOf does", () => {
    const shot = { path: A, image: { format: "png" } };
    expect(pictureRowOf(shot)).toEqual({ path: A, stopped: false });
    expect(pictureRowOf({ ...shot, modelUse: "stopped" })).toEqual({
      path: A,
      stopped: true,
    });
    // A value a later version may add reads as absent.
    expect(pictureRowOf({ ...shot, modelUse: "pinned" })).toEqual({
      path: A,
      stopped: false,
    });
    for (const unreadable of ["no_caption", "too_large"])
      expect(pictureRowOf({ ...shot, unreadable })).toEqual({
        path: A,
        stopped: false,
      });
  });

  it("refuses documents, missing paths and pictures without a copy", () => {
    expect(pictureRowOf(null)).toBeNull();
    expect(pictureRowOf({ path: A })).toBeNull();
    expect(pictureRowOf({ path: "", image: {} })).toBeNull();
    for (const unreadable of [
      "removed",
      "denied",
      "read_error",
      "binary",
      "empty",
    ])
      expect(pictureRowOf({ path: A, image: {}, unreadable })).toBeNull();
  });
});

describe("latestPictureResults (F04, R116): the newest request's outcome per row", () => {
  it("reads the newest round with pictures, both models, by index and path together", () => {
    const results = latestPictureResults(
      [
        round(0, { persona: [{ index: 0, path: A, outcome: "sent" }] }),
        round(3, {
          persona: [
            { index: 0, path: A, outcome: "over_limit" },
            { index: 1, path: B, outcome: "unsupported" },
          ],
          executor: [{ index: 1, path: B, outcome: "sent" }],
        }),
        // A later round that stopped before its request recorded nothing.
        round(6),
      ],
      9,
    );
    expect(results(0, A)).toEqual({
      sent: [],
      missed: [{ role: "persona", why: "over_limit" }],
    });
    expect(results(1, B)).toEqual({
      sent: ["executor"],
      missed: [{ role: "persona", why: "unsupported" }],
    });
    // Same index, another file (a rewind since): no result.
    expect(results(0, B)).toBeUndefined();
    expect(results(2, A)).toBeUndefined();
  });

  it("skips a round a rewind withdrew, and has nothing to say without rounds", () => {
    const rounds = [
      round(0, { persona: [{ index: 0, path: A, outcome: "sent" }] }),
      round(4, { persona: [{ index: 0, path: A, outcome: "stopped" }] }),
    ];
    expect(latestPictureResults(rounds, 4)(0, A)).toEqual({
      sent: ["persona"],
      missed: [],
    });
    expect(latestPictureResults(rounds, 5)(0, A)).toEqual({
      sent: [],
      missed: [{ role: "persona", why: "stopped" }],
    });
    expect(latestPictureResults([], 5)(0, A)).toBeUndefined();
  });
});
