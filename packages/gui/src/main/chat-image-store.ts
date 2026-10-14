import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateMessageImage, type MessageImage } from "@herta/providers/images";

interface ImageRef { storage: "sha256"; sha256: string; mimeType: MessageImage["mimeType"] }
function isRef(v: unknown): v is ImageRef {
  const r = v as ImageRef | null;
  return !!r && r.storage === "sha256" && /^[a-f0-9]{64}$/.test(r.sha256) && ["image/png", "image/jpeg"].includes(r.mimeType);
}

/** Append-only content-addressed files. No cleanup: backups may still reference old images. */
export function createChatImageStore(directory: string) {
  const cached = new WeakMap<MessageImage, ImageRef>();
  const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  function checkDirectory() {
    if (existsSync(directory)) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("图片存储目录无效。");
    } else mkdirSync(directory, { recursive: true });
  }
  function read(ref: ImageRef): MessageImage {
    checkDirectory();
    const file = join(directory, ref.sha256), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("图片文件无效。");
    const bytes = readFileSync(file);
    if (hash(bytes) !== ref.sha256) throw new Error("图片校验失败。");
    const image = validateMessageImage({ mimeType: ref.mimeType, data: bytes.toString("base64") });
    cached.set(image, ref);
    return image;
  }
  function put(value: MessageImage): ImageRef {
    const previous = cached.get(value);
    if (previous) return previous;
    const image = validateMessageImage(value), bytes = Buffer.from(image.data, "base64");
    const ref: ImageRef = { storage: "sha256", sha256: hash(bytes), mimeType: image.mimeType };
    checkDirectory();
    const file = join(directory, ref.sha256);
    if (existsSync(file)) read(ref);
    else {
      const total = readdirSync(directory).reduce((sum, name) => sum + lstatSync(join(directory, name)).size, 0);
      if (total + bytes.length > 256 * 1024 * 1024) throw new Error("聊天图片存储已达256 MB，请先备份数据。");
      const temporary = join(directory, `${ref.sha256}.${randomUUID()}.tmp`);
      writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
      renameSync(temporary, file);
    }
    cached.set(value, ref);
    return ref;
  }
  return {
    referenceImage: put,
    readImage(ref: unknown): MessageImage {
      if (!isRef(ref)) throw new Error("图片引用无效。");
      return read(ref);
    },
    usage() {
      const limitBytes = 256 * 1024 * 1024;
      if (!existsSync(directory)) return { bytes: 0, files: 0, limitBytes };
      const directoryStat = lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("图片存储目录无效。");
      let bytes = 0, files = 0;
      for (const name of readdirSync(directory)) {
        const stat = lstatSync(join(directory, name));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("图片存储包含无法统计的文件。");
        bytes += stat.size;
        if (/^[a-f0-9]{64}$/.test(name)) files++;
      }
      return { bytes, files, limitBytes };
    },
    serialize(store: unknown): string {
      return JSON.stringify(store, (key, value) => {
        if (key === "schemaVersion") return 3;
        if (key === "image" && value?.data) return put(value);
        // Retain unavailable references rather than deleting missing attachments on the next save.
        if (key === "attachments" && Array.isArray(value)) return value.map(a => {
          if (!a.imageRef) return a;
          if (!isRef(a.imageRef)) throw new Error("图片引用无效。");
          const { imageMissing, imageRef, ...rest } = a;
          return { ...rest, image: imageRef };
        });
        return value;
      });
    },
    hydrate(store: unknown, deferred = false): unknown {
      return JSON.parse(JSON.stringify(store), (key, value) => {
        if (key === "attachments" && Array.isArray(value)) return value.map(a => {
          if (!a.image) return a;
          if (!isRef(a.image)) throw new Error("图片引用无效。");
          if (deferred) { const { image, ...rest } = a; return { ...rest, imageRef: image }; }
          try { return { ...a, image: read(a.image) }; }
          catch { const { image, ...rest } = a; return { ...rest, imageMissing: true, imageRef: image }; }
        });
        if (key === "schemaVersion") return 2;
        return value;
      });
    },
  };
}
