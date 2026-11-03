import type { RoundPicture, RoundSummary } from "@herta/app-server";

/**
 * F04 (R116): the workbench side of "stop sending a picture to the models". The record row carries
 * the user's choice (`modelUse: "stopped"` on its attachment digest); each round carries what its
 * requests did with every picture row (`RoundSummary.pictures`). Words live in the component.
 */

export type PictureRole = "persona" | "executor";
export type PictureMiss = Exclude<RoundPicture["outcome"], "sent">;

/** What the latest request of each model did with one picture row. */
export interface PictureResult {
  readonly sent: readonly PictureRole[];
  readonly missed: readonly {
    readonly role: PictureRole;
    readonly why: PictureMiss;
  }[];
}

/** The digest fields the choice depends on (core `terminal-record.ts`, attachment digest). */
interface PictureDigest {
  readonly path: string;
  readonly image?: unknown;
  readonly unreadable?: string;
  readonly modelUse?: string;
}

/**
 * A row the session's `setPictureModelUse` accepts: a picture with a stored copy (app-server
 * `imageRowOf`), so not taken back, refused or failed. Any `modelUse` other than "stopped" is
 * read as absent, as the session reads it.
 */
export function pictureRowOf(
  digest: PictureDigest | null | undefined,
): { readonly path: string; readonly stopped: boolean } | null {
  if (!digest || digest.image === undefined || digest.path === "") return null;
  const u = digest.unreadable;
  if (u !== undefined && u !== "no_caption" && u !== "too_large") return null;
  return { path: digest.path, stopped: digest.modelUse === "stopped" };
}

const ROLES: readonly PictureRole[] = ["persona", "executor"];

/**
 * The newest round that recorded its pictures, as a lookup by row. A row matches only when its
 * absolute index AND stored path agree, since a rewind reuses indices. A round starting at or
 * past the record's end was withdrawn by a rewind and is skipped.
 */
export function latestPictureResults(
  rounds: readonly RoundSummary[],
  recordEnd: number,
): (index: number, path: string) => PictureResult | undefined {
  let latest: RoundSummary["pictures"];
  for (const round of rounds)
    if (round.pictures !== undefined && round.recordStart < recordEnd)
      latest = round.pictures;
  const rows = new Map<
    string,
    { sent: PictureRole[]; missed: { role: PictureRole; why: PictureMiss }[] }
  >();
  for (const role of ROLES)
    for (const p of latest?.[role] ?? []) {
      const key = `${p.index}\n${p.path}`;
      const row = rows.get(key) ?? { sent: [], missed: [] };
      if (p.outcome === "sent") row.sent.push(role);
      else row.missed.push({ role, why: p.outcome });
      rows.set(key, row);
    }
  return (index, path) => rows.get(`${index}\n${path}`);
}
