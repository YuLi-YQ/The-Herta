import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditChatImages } from "./chat-image-audit.js";
import type { ChatImageBatch } from "../shared/herta-chat.js";

const IMAGE = /^[a-f0-9]{64}$/, BATCH = /^\d{8}T\d{6}-[a-f0-9]{8}$/;
const PREVIEW_MS = 10 * 60 * 1000;

/**
 * Sets unreferenced chat images aside in restorable batches (R43). Every move re-checks references
 * first; nothing leaves the disk without a second, explicit discard of one batch.
 */
export function createChatImageQuarantine(history: string, limitBytes = 256 * 1024 * 1024) {
  const library = `${history}.images`, root = `${history}.images-quarantine`;
  const previews = new Map<string, { names: Set<string>; expires: number }>();
  const isDirectory = (path: string) => {
    if (!existsSync(path)) return false;
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("图片目录无效，暂不能清理。");
    return true;
  };
  const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  function unreferenced() {
    const found = new Map<string, number>();
    if (!auditChatImages(history, found).complete) throw new Error("部分记录或文件无法检查，暂不能清理图片。");
    return found;
  }
  function batch(id: unknown) {
    if (typeof id !== "string" || !BATCH.test(id)) throw new Error("隔离批次无效。");
    const dir = join(root, id);
    if (!isDirectory(root) || !isDirectory(dir)) throw new Error("隔离批次不存在。");
    const files = readdirSync(dir).filter(name => IMAGE.test(name)).map(name => ({ name, file: join(dir, name), stat: lstatSync(join(dir, name)) }));
    return { dir, files };
  }
  const at = (id: string) => `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(9, 11)}:${id.slice(11, 13)}:${id.slice(13, 15)}Z`;
  return {
    preview() {
      const found = unreferenced(), now = Date.now();
      for (const [key, value] of previews) if (value.expires < now) previews.delete(key);
      const bytes = [...found.values()].reduce((sum, size) => sum + size, 0);
      if (!found.size) return { files: 0, bytes: 0 };
      const token = randomUUID();
      previews.set(token, { names: new Set(found.keys()), expires: now + PREVIEW_MS });
      return { token, files: found.size, bytes, expiresAt: new Date(now + PREVIEW_MS).toISOString() };
    },
    /** Moves only images that were previewed and are still unreferenced right now. */
    isolate(token: unknown) {
      const preview = typeof token === "string" ? previews.get(token) : undefined;
      if (!preview || preview.expires < Date.now()) throw new Error("清理预览已过期，请重新预览。");
      previews.delete(token as string);
      const found = unreferenced();
      const names = [...preview.names].filter(name => found.has(name));
      if (!names.length) return { files: 0, bytes: 0, skipped: preview.names.size };
      if (!isDirectory(root)) mkdirSync(root);
      const id = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(4).toString("hex")}`;
      const dir = join(root, id);
      mkdirSync(dir);
      const moved: { name: string; bytes: number }[] = [];
      try {
        for (const name of names) {
          const from = join(library, name), stat = lstatSync(from);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          renameSync(from, join(dir, name));
          moved.push({ name, bytes: stat.size });
        }
      } finally {
        // A record of what moved, written atomically even if a move failed midway.
        const temporary = join(dir, `manifest.${randomUUID()}.tmp`);
        writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), source: "chat-images", files: moved }, null, 2), { flag: "wx", mode: 0o600 });
        renameSync(temporary, join(dir, "manifest.json"));
      }
      return { id, files: moved.length, bytes: moved.reduce((sum, f) => sum + f.bytes, 0), skipped: preview.names.size - moved.length };
    },
    batches(): ChatImageBatch[] {
      if (!isDirectory(root)) return [];
      return readdirSync(root).filter(id => BATCH.test(id)).sort().reverse().slice(0, 50).flatMap(id => {
        try {
          const { files } = batch(id);
          return [{ id, at: at(id), files: files.length, bytes: files.reduce((sum, f) => sum + f.stat.size, 0) }];
        } catch { return []; }
      });
    },
    /** Moves a batch back after checking each file against its content name and the library limit. */
    restore(id: unknown) {
      const { dir, files } = batch(id);
      if (!isDirectory(library)) mkdirSync(library);
      let rejected = 0, needed = 0;
      const plan: { name: string; file: string; duplicate: boolean }[] = [];
      for (const f of files) {
        if (!f.stat.isFile() || f.stat.isSymbolicLink() || sha(f.file) !== f.name) { rejected++; continue; }
        // A content-addressed name alone does not prove that the destination
        // is intact. Keep the recoverable copy on collisions or read failures.
        let duplicate = false;
        const destination = join(library, f.name);
        try {
          const target = lstatSync(destination);
          if (!target.isFile() || target.isSymbolicLink() ||
              target.size !== f.stat.size || sha(destination) !== f.name) {
            rejected++;
            continue;
          }
          duplicate = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            rejected++;
            continue;
          }
        }
        if (!duplicate) needed += f.stat.size;
        plan.push({ name: f.name, file: f.file, duplicate });
      }
      const used = readdirSync(library).reduce((sum, name) => sum + lstatSync(join(library, name)).size, 0);
      if (used + needed > limitBytes) throw new Error("恢复后图片库会超过 256 MB 上限，请先备份或清理其他图片。");
      for (const p of plan) p.duplicate ? unlinkSync(p.file) : renameSync(p.file, join(library, p.name));
      if (!rejected) rmSync(dir, { recursive: true });
      return { restored: plan.filter(p => !p.duplicate).length, duplicates: plan.filter(p => p.duplicate).length, rejected };
    },
    /** Permanently deletes one batch; only called after the user confirms. */
    discard(id: unknown) {
      const { dir, files } = batch(id);
      const bytes = files.reduce((sum, f) => sum + f.stat.size, 0);
      rmSync(dir, { recursive: true });
      return { files: files.length, bytes };
    },
  };
}
