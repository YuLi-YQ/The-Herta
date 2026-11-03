import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname } from "node:path";
import { writeFileAtomicSync } from "@herta/core";
import type { StagedImage } from "./staged-images.js";

export interface PendingImageManifest {
  readonly version: 1;
  readonly sessionId: string;
  readonly revision: number;
  readonly images: readonly StagedImage[];
}

/** References only. Never follows a stored path, reads pixels or sends a message. */
export class PendingImageJournal {
  constructor(private readonly path: string, private readonly sessionId: string) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) throw new Error("Invalid session ID");
  }

  read(): PendingImageManifest {
    let raw: string;
    try { raw = readFileSync(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, sessionId: this.sessionId, revision: 0, images: [] };
      throw new Error("待发图片清单无法读取；原文件保留。", { cause: error });
    }
    try {
      if (raw.length > 128_000) throw new Error("oversize");
      const data = JSON.parse(raw) as PendingImageManifest;
      if (data.version !== 1 || data.sessionId !== this.sessionId ||
          !Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error("schema");
      this.validateImages(data.images);
      return data;
    } catch (error) {
      throw new Error("待发图片清单损坏或版本不受支持；原文件保留。", { cause: error });
    }
  }

  /** Synchronous compare-and-replace for the single owning main process.
   * Not a cross-process lock. A corrupt existing file is never overwritten. */
  replace(expectedRevision: number, images: readonly StagedImage[]): PendingImageManifest {
    this.validateImages(images);
    const current = this.read();
    if (current.revision !== expectedRevision) throw new Error("待发图片清单已更新，请重新读取。");
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw new Error("待发图片清单版本已达上限。");
    const next: PendingImageManifest = {
      version: 1, sessionId: this.sessionId, revision: current.revision + 1,
      images: images.map(({ id, name, path, width, height }) => ({
        id, name, path, ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
      })),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileAtomicSync(this.path, JSON.stringify(next), { fsync: true });
    return next;
  }

  /** The user's explicit reset of an unreadable manifest (R98): its bytes move to a new name
   * beside it and are never rewritten or deleted, and the next replace starts at revision 0.
   * A readable manifest is refused — this is not a way to drop pending pictures. */
  quarantine(now = new Date()): string {
    let readable = false;
    try { this.read(); readable = true; } catch { /* the case this exists for */ }
    if (readable) throw new Error("待发图片清单可以正常读取，无需重置。");
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    let backup = `${this.path}.damaged-${stamp}`;
    for (let n = 2; existsSync(backup); n++) backup = `${this.path}.damaged-${stamp}-${n}`;
    renameSync(this.path, backup);
    return basename(backup);
  }

  private validateImages(value: unknown): asserts value is readonly StagedImage[] {
    if (!Array.isArray(value) || value.length > 5) throw new Error("Invalid image list");
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const item of value) {
      if (!item || typeof item !== "object" ||
          typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) ||
          typeof item.name !== "string" || item.name.length === 0 || item.name.length > 1024 ||
          typeof item.path !== "string" || item.path.length > 4096) throw new Error("Invalid image entry");
      const parts = item.path.split("/");
      if (parts.length !== 4 || parts[0] !== ".herta" || parts[1] !== "attachments" ||
          parts[2] !== this.sessionId || !parts[3] || parts[3] === "." || parts[3] === ".." ||
          /[\\:\x00-\x1f]/.test(parts[3]) || /[ .]$/.test(parts[3])) throw new Error("Invalid image path");
      for (const dimension of [item.width, item.height]) {
        if (dimension !== undefined && (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 1_000_000))
          throw new Error("Invalid image dimension");
      }
      if (ids.has(item.id) || paths.has(item.path)) throw new Error("Duplicate image entry");
      ids.add(item.id); paths.add(item.path);
    }
  }
}
