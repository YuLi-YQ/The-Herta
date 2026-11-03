import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { PageMarkerLang, SystemBlock } from "@herta/core";
import type { PendingImageJournal } from "./pending-image-journal.js";
import { ownedImagePath } from "./restore-staged-image.js";
import {
  CAPTION_TIMEOUT_MS,
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
 * Without a pending adapter, staging remains per-session and in-memory:
 * opted-in neutral sessions instead preserve pending references on suspend.
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
  | "read_error"
  /** The task's pending-picture manifest is unreadable (R98): nothing can be
   *  staged until the user resets it. */
  | "manifest_unreadable"
  /** The picture was read but its pending reference could not be saved. */
  | "not_saved"
  /** The person cancelled the card while it was read (R118): no copy is
   *  kept, nothing is recorded, no caption starts. */
  | "cancelled";

interface Entry {
  readonly staged: StagedImage;
  readonly relPath: string;
  /** The captioning call, started at stage time. Resolves to the final record
   *  block. Never rejects — `captionStoredImage` degrades instead. */
  readonly block: Promise<SystemBlock> | (() => Promise<SystemBlock>);
  /** Stops the caption call when the entry goes before it is sent (R118):
   *  an unstaged picture's caption was paid for and then thrown away. */
  readonly stopCaption?: AbortController;
}

export class StagedImageStore {
  private readonly entries = new Map<string, Entry>();
  private generation = 0;
  private revision = 0;
  private durable = new Map<string, StagedImage>();
  private fault: string | null = null;
  get recoveryError(): string | null { return this.fault; }

  constructor(
    private readonly deps: {
      readonly workspaceRoot: () => string;
      readonly sessionId: string;
      readonly lang: PageMarkerLang;
      readonly caption: () => ImageCaptioner | null;
      /** The picture itself rides the message (R77): see `captionStoredImage`. */
      readonly deliver?: boolean;
      /** Opt-in lifecycle adapter. The owner supplies safe pixel loading and
       * paths from the durable record, never from an in-flight UI snapshot. */
      readonly pending?: {
        readonly journal: PendingImageJournal;
        readonly restoreBlock: (image: StagedImage) => Promise<SystemBlock>;
        readonly committedPaths: () => ReadonlySet<string>;
      };
    },
  ) {
    const pending = deps.pending;
    if (!pending) return;
    let saved;
    try { saved = pending.journal.read(); }
    catch { this.fault = "待发图片清单无法读取，原文件已保留；本次不会自动发送图片。重置清单后可重新添加图片。"; return; }
    this.revision = saved.revision;
    const committed = pending.committedPaths();
    for (const image of saved.images) {
      if (committed.has(image.path)) continue;
      this.durable.set(image.id, image);
      this.entries.set(image.id, {
        staged: image, relPath: image.path,
        block: () => pending.restoreBlock(image),
      });
    }
  }

  private persist(next = new Map(this.durable)): void {
    const pending = this.deps.pending;
    if (!pending) return;
    if (this.fault) throw new Error(this.fault);
    const committed = pending.committedPaths();
    for (const [id, image] of next) if (committed.has(image.path)) next.delete(id);
    const saved = pending.journal.replace(this.revision, [...next.values()]);
    this.revision = saved.revision;
    this.durable = next;
  }

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
    readonly signal?: AbortSignal;
  }): Promise<
    | { readonly ok: true; readonly image: StagedImage }
    | {
        readonly ok: false;
        readonly reason: StageRejection;
      }
  > {
    // A refusal, not a throw (R98): the composer then says what is wrong
    // instead of "the file could not be read".
    if (this.fault) return { ok: false, reason: "manifest_unreadable" };
    // The id is minted BEFORE storing and rides the stored NAME: every
    // staged copy owns exactly one file. Content-hashed names alone aliased
    // re-staged bytes onto a copy a committed record block already cited,
    // and deleting the staged entry broke the record's picture (2026-08-27).
    const id = randomUUID();
    const generation = this.generation;
    const workspaceRoot = this.deps.workspaceRoot();
    const result = await stageImageSource({
      ...(input.sourcePath !== undefined
        ? { sourcePath: input.sourcePath }
        : {}),
      ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
      displayName: input.displayName,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      workspaceRoot,
      sessionId: this.deps.sessionId,
      disambiguator: id.slice(0, 8),
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    const stored: StoredImage = result.stored;
    if (generation !== this.generation) {
      await this.deleteCopy(stored.relPath, workspaceRoot);
      return { ok: false, reason: "read_error" };
    }
    // Cancelled while the copy was written: it is deleted before anything
    // records it or a caption is asked for (R118).
    if (input.signal?.aborted === true) {
      await this.deleteCopy(stored.relPath, workspaceRoot);
      return { ok: false, reason: "cancelled" };
    }
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
    if (this.deps.pending) {
      const next = new Map(this.durable);
      next.set(id, image);
      try { this.persist(next); }
      catch {
        // Not reported as staged, so the copy is not kept either.
        await this.deleteCopy(stored.relPath, workspaceRoot);
        return { ok: false, reason: "not_saved" };
      }
    }
    const stopCaption = new AbortController();
    const block = captionStoredImage(stored, {
      lang: this.deps.lang,
      caption: this.deps.caption(),
      deliver: this.deps.deliver === true,
      signal: AbortSignal.any([
        stopCaption.signal,
        AbortSignal.timeout(CAPTION_TIMEOUT_MS),
      ]),
    })
      .then((r) => r.block)
      .catch(() => captionlessBlock(stored));
    this.entries.set(id, {
      staged: image,
      relPath: stored.relPath,
      block,
      stopCaption,
    });
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
    if (this.deps.pending) {
      const next = new Map(this.durable);
      for (const [oldId, old] of next) if (old.path === image.path) next.delete(oldId);
      next.set(id, image);
      this.persist(next);
    }
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
   * The in-flight caption is aborted (R118; until then it was left to
   * settle and its result discarded): nobody will read it.
   */
  async unstage(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (entry === undefined) return false;
    if (this.deps.pending) {
      const next = new Map(this.durable);
      next.delete(id);
      this.persist(next);
    }
    this.entries.delete(id);
    entry.stopCaption?.abort();
    await this.deleteCopy(entry.relPath);
    return true;
  }

  /**
   * Read the restored pictures among `ids` now, at the user's send and before
   * anything else of the message is committed (R98): a document attached
   * ahead of the message must not land in the record for a message that a
   * missing picture then refuses. A picture read here is kept for `commit`,
   * so its bytes are read once. Returns the ids that could not be read; their
   * entries stay, so the card can still be removed.
   */
  async prepare(ids: readonly string[]): Promise<readonly string[]> {
    const unreadable: string[] = [];
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry === undefined || typeof entry.block !== "function") continue;
      try {
        const block = await entry.block();
        if (this.entries.get(id) === entry)
          this.entries.set(id, { ...entry, block: Promise.resolve(block) });
      } catch {
        unreadable.push(id);
      }
    }
    return unreadable;
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
    // Keep durable references until the owner confirms a persisted record.
    // A crash before append must recover these pictures, without auto-send.
    const generation = this.generation;
    try {
      return await Promise.all(taken.map((e) => typeof e.block === "function" ? e.block() : e.block));
    } catch (error) {
      if (this.deps.pending && generation === this.generation)
        for (const entry of taken) this.entries.set(entry.staged.id, entry);
      throw error;
    }
  }

  /** Normal close for an opted-in owner. Explicit abandon still uses clear(). */
  async suspend(): Promise<void> {
    if (!this.deps.pending) return this.clear();
    this.generation += 1;
    // Every successful mutation was already persisted. Reconciliation failure
    // must not stop session shutdown or delete the only recoverable copy.
    try { this.persist(); } catch { /* original manifest remains for next open */ }
    // Reopened, these come back through restoreBlock: no caption is waiting on them (R118).
    for (const entry of this.entries.values()) entry.stopCaption?.abort();
    this.entries.clear();
  }

  /**
   * The user's explicit answer to an unreadable manifest (R98): the damaged
   * file is set aside under a new name, kept byte for byte, and staging
   * starts again from an empty manifest. The pictures it listed are not
   * restored and their stored copies are not deleted — a damaged list cannot
   * say which copies are safe to remove. Returns the backup's file name.
   */
  resetRecovery(): string {
    const pending = this.deps.pending;
    if (!pending || this.fault === null) throw new Error("没有需要重置的待发图片清单。");
    const backup = pending.journal.quarantine();
    // Staging and restaging were refused while the fault stood, so nothing
    // is in memory that the empty manifest would forget.
    this.fault = null;
    this.revision = 0;
    this.durable = new Map();
    return backup;
  }

  /**
   * Abandon everything still staged, deleting the copies. Called when the
   * session closes: a picture the user never sent should not outlive the
   * composer it was sitting in.
   */
  async clear(): Promise<void> {
    this.generation += 1;
    if (this.deps.pending) this.persist(new Map());
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) entry.stopCaption?.abort();
    await Promise.all(entries.map((e) => this.deleteCopy(e.relPath)));
  }

  /** Best-effort: a copy that cannot be deleted is a stray file, never a
   *  failed user action. */
  private async deleteCopy(relPath: string, workspaceRoot = this.deps.workspaceRoot()): Promise<void> {
    try {
      await rm(await ownedImagePath(workspaceRoot, this.deps.sessionId, relPath), {
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




