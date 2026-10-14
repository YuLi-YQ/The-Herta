import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ChatImageAudit } from "../shared/herta-chat.js";

/** Read-only inventory of this store and its adjacent automatic backups; never a deletion authorization. */
export function auditChatImages(history: string): ChatImageAudit {
  const result: ChatImageAudit = { complete: true, current: 0, backupOnly: 0, unreferenced: 0, unreferencedBytes: 0, missing: 0, checkedBackups: 0 };
  const required = new Set<string>(), current = new Set<string>(), backups = new Set<string>(), present = new Set<string>();
  let budget = 128 * 1024 * 1024;
  function scan(file: string, refs: Set<string>, active = false) {
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 64 * 1024 * 1024 || st.size > budget) throw new Error("Uninspectable history");
    budget -= st.size;
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (![1, 2, 3].includes(value.schemaVersion)) throw new Error("Unknown schema");
    const chats = value.schemaVersion === 1 ? [{ messages: value.messages }] : value.chats;
    if (!Array.isArray(chats)) throw new Error("Invalid chats");
    for (const chat of chats) {
      if (!Array.isArray(chat.messages)) throw new Error("Invalid messages");
      for (const message of chat.messages) {
        if (message.attachments === undefined) continue;
        if (!Array.isArray(message.attachments)) throw new Error("Invalid attachments");
        for (const attachment of message.attachments) {
          const image = attachment.image ?? attachment.imageRef;
          if (!image) continue;
          if (image.storage === "sha256" && /^[a-f0-9]{64}$/.test(image.sha256)) { refs.add(image.sha256); if (active) required.add(image.sha256); }
          else if (typeof image.data === "string" && image.data.length <= 3 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(image.data))
            refs.add(createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex"));
          else throw new Error("Unknown image reference");
        }
      }
    }
  }
  try {
    scan(history, current, true);
    const base = basename(history);
    const names = readdirSync(dirname(history)).filter(n => n.startsWith(`${base}.`) && n !== `${base}.images` && !n.startsWith(`${base}.memory.`));
    if (names.length > 100) result.complete = false;
    for (const name of names.slice(0, 100)) {
      // Unknown backup conventions are not silently ignored.
      if (!(name === `${base}.tmp` || name.startsWith(`${base}.v1-backup-`) || name.startsWith(`${base}.v2-backup-`))) { result.complete = false; continue; }
      try { scan(join(dirname(history), name), backups); result.checkedBackups++; }
      catch { result.complete = false; }
    }
    const directory = `${history}.images`;
    if (existsSync(directory)) {
      const st = lstatSync(directory);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Invalid image directory");
      for (const name of readdirSync(directory)) {
        const st = lstatSync(join(directory, name));
        if (!st.isFile() || st.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(name)) { result.complete = false; continue; }
        present.add(name);
        if (current.has(name)) result.current++;
        else if (backups.has(name)) result.backupOnly++;
        else { result.unreferenced++; result.unreferencedBytes += st.size; }
      }
    }
    result.missing = [...required].filter(ref => !present.has(ref)).length;
  } catch { result.complete = false; }
  return result;
}
