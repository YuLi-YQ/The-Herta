import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { PageMarkerLang, SystemBlock } from "@herta/core";
import {
  captionStoredImage,
  type ImageCaptioner,
  type StoredImage,
  stageImageSource,
} from "./attachments.js";

/**
 * Images waiting in the composer (ADR 0048 §4).
 *
 * A picture the 开拓者 picks or pastes does NOT enter the record when it
 * arrives — it waits in the composer strip until they hit send. Three things
 * come from that, and they are the reason the flow is worth the machinery:
 *
 * 1. **The × actually un-happens it.** The record is append-only, so under the
 *    old immediate-ingest flow a mis-attached file was in the book forever.
 *    For images that is a privacy matter: screenshots routinely catch the
 *    wrong window, a token, someone's name.
 * 2. **The caption cost disappears under typing.** Captioning starts the
 *    moment the image is staged and runs while the user writes their message;
 *    by send it is almost always already resolved (measured 2-11s, and a
 *    sentence takes longer to type than that).
 * 3. **The image binds to the turn.** Blocks are appended after the user
 *    block, inside the turn's span — so "开拓者 said X and showed me this" is
 *    one episode, and a rewind withdraws the picture with the message it came
 *    with (the withdrawn-attachment GC then deletes the stored copy).
 *
 * Everything here is per-session and in-memory: staging is transient state,
 * and a staged image that never gets sent is not part of anything durable.
 */

/** Most pictures ONE message can carry (owner 2026-08-27). A message is a
 *  moment in the record, not an album: each image adds a caption block for
 *  the actor to read and a thumb row on the bubble, and past a handful the
 *  moment stops being readable. Enforced at the session's staging door
 *  (already-staged + incoming), whole-batch like the attachFiles cap. */
export const MAX_STAGED_IMAGES = 5;

export interface StagedImage {
  readonly id: string;
  /** The name the user knows it by. */
  readonly name: string;
  /** Workspace-relative stored path — what the thumbnail protocol serves. */
  readonly path: string;
  readonly width?: number;
  readonly height?: number;
}

export type StageRejection =
  | "not_image"
  | "denied"
  | "too_large"
  | "read_error";

interface Entry {
  readonly staged: StagedImage;
  readonly relPath: string;
  /** The captioning call, started at stage time. Resolves to the final record
   *  block. Never rejects — `captionStoredImage` degrades instead. */
  readonly block: Promise<SystemBlock>;
}

export class StagedImageStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly deps: {
      readonly workspaceRoot: () => string;
      readonly sessionId: string;
      readonly lang: PageMarkerLang;
      readonly caption: () => ImageCaptioner | null;
    },
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /**
   * Store one picture and START captioning it. Returns the handle the strip
   * draws, or why it was refused.
   *
   * The caption promise is deliberately NOT awaited: that is the whole point
   * of staging. It is also given `void`-safe handling — an unhandled rejection
   * here would be a crash in the main process on a background failure — but
   * `captionStoredImage` never rejects, so the catch is a belt.
   */
  async stage(input: {
    readonly sourcePath?: string;
    readonly bytes?: Buffer;
    readonly displayName: string;
  }): Promise<
    | { readonly ok: true; readonly image: StagedImage }
    | {
        readonly ok: false;
        readonly reason: StageRejection;
      }
  > {
    // The id is minted BEFORE storing and rides the stored NAME: every
    // staged copy owns exactly one file. Content-hashed names alone aliased
    // re-staged bytes onto a copy a committed record block already cited,
    // and deleting the staged entry broke the record's picture (2026-08-27).
    const id = randomUUID();
    const result = await stageImageSource({
      ...(input.sourcePath !== undefined
        ? { sourcePath: input.sourcePath }
        : {}),
      ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
      displayName: input.displayName,
      workspaceRoot: this.deps.workspaceRoot(),
      sessionId: this.deps.sessionId,
      disambiguator: id.slice(0, 8),
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    const stored: StoredImage = result.stored;
    const image: StagedImage = {
      id,
      name: stored.displayName,
      path: stored.relPath,
      ...(stored.image.width !== undefined
        ? { width: stored.image.width }
        : {}),
      ...(stored.image.height !== undefined
        ? { height: stored.image.height }
        : {}),
    };
    const block = captionStoredImage(stored, {
      lang: this.deps.lang,
      caption: this.deps.caption(),
    })
      .then((r) => r.block)
      .catch(() => captionlessBlock(stored));
    this.entries.set(id, { staged: image, relPath: stored.relPath, block });
    return { ok: true, image };
  }

  list(): readonly StagedImage[] {
    return [...this.entries.values()].map((e) => e.staged);
  }

  /**
   * Adopt a WITHDRAWN image block back into the strip (rewind, owner
   * 2026-08-27): the stored copy is already on disk and the caption is
   * already paid for, so the entry's block promise resolves immediately —
   * minus the old `at` stamp, which the output boundary re-stamps if the
   * picture is sent again. Ownership transfers cleanly: the record no
   * longer cites the path, and this entry now owns the file exactly like
   * any staged copy (unstage/clear delete it).
   *
   * Returns null for a block that is not a restageable image (no image
   * digest, no stored path, or the ✕ already took the file) — the caller
   * falls back to the GC.
   */
  restage(block: SystemBlock): StagedImage | null {
    const d = block.digest;
    if (d?.kind !== "attachment" || d.image === undefined) return null;
    if (d.path.length === 0 || d.unreadable === "removed") return null;
    const id = randomUUID();
    const image: StagedImage = {
      id,
      name: d.name,
      path: d.path,
      ...(d.image.width !== undefined ? { width: d.image.width } : {}),
      ...(d.image.height !== undefined ? { height: d.image.height } : {}),
    };
    const { at: _at, ...withoutAt } = block;
    this.entries.set(id, {
      staged: image,
      relPath: d.path,
      block: Promise.resolve(withoutAt),
    });
    return image;
  }

  /**
   * Drop a staged image and delete its stored copy. Nothing about it ever
   * reached the record, so nothing is left behind to explain — which is the
   * difference between this and `removeAttachment`, where the block stays and
   * is MARKED because Herta may already have spoken about the file.
   *
   * The in-flight caption is left to settle on its own: it holds only the
   * bytes it was given, and its result is discarded with the entry.
   */
  async unstage(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (entry === undefined) return false;
    this.entries.delete(id);
    await this.deleteCopy(entry.relPath);
    return true;
  }

  /**
   * Take the blocks for the given ids, in the order the caller asks for, and
   * clear them from the store. Awaits each caption — by send time it has
   * almost always resolved, and when it has not, the block must still be
   * complete before it enters the record (the record is append-only: there is
   * no later moment to fill a caption in).
   */
  async commit(ids: readonly string[]): Promise<readonly SystemBlock[]> {
    const taken: Entry[] = [];
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry === undefined) continue; // already sent, or unstaged
      this.entries.delete(id);
      taken.push(entry);
    }
    return Promise.all(taken.map((e) => e.block));
  }

  /**
   * Abandon everything still staged, deleting the copies. Called when the
   * session closes: a picture the user never sent should not outlive the
   * composer it was sitting in.
   */
  async clear(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((e) => this.deleteCopy(e.relPath)));
  }

  /** Best-effort: a copy that cannot be deleted is a stray file, never a
   *  failed user action. */
  private async deleteCopy(relPath: string): Promise<void> {
    try {
      await rm(join(this.deps.workspaceRoot(), ...relPath.split("/")), {
        force: true,
      });
    } catch {
      // Nothing to do — the file stays; the record never mentioned it.
    }
  }
}

/** Belt for the never-taken branch: a block that says the picture is stored
 *  and unread, which is true whatever went wrong above it. */
function captionlessBlock(stored: StoredImage): SystemBlock {
  return {
    kind: "system",
    label: "系统",
    body: `附件 ${stored.displayName} · 图片 ${stored.image.format.toUpperCase()} · 已存图片，未能读图 · ${stored.relPath}`,
    digest: {
      kind: "attachment",
      name: stored.displayName,
      path: stored.relPath,
      lines: 0,
      chars: 0,
      image: stored.image,
      unreadable: "no_caption",
    },
  };
}
