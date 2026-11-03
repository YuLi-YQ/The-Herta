import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { PageMarkerLang, SystemBlock } from "@herta/core";
import { captionStoredImage } from "./attachments.js";
import { sniffImage } from "./image.js";
import type { StagedImage } from "./staged-images.js";

/** Reject links at every attachment component, not only lexical traversal. */
export async function ownedImagePath(root: string, sessionId: string, path: string): Promise<string> {
  const parts = path.split("/");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId) || parts.length !== 4 ||
      parts[0] !== ".herta" || parts[1] !== "attachments" || parts[2] !== sessionId ||
      !parts[3] || parts[3] === "." || parts[3] === ".." || /[\\:\x00-\x1f]/.test(parts[3]))
    throw new Error("Invalid attachment path");
  let full = await realpath(root);
  for (const [index, part] of parts.entries()) {
    full = join(full, part);
    const info = await lstat(full);
    if (info.isSymbolicLink() || (index < 3 ? !info.isDirectory() : !info.isFile()))
      throw new Error("Unsafe attachment path");
  }
  return full;
}

/** Called on explicit send, never at restore or via a caption provider. */
export async function restoreStagedImage(root: string, sessionId: string, image: StagedImage, lang: PageMarkerLang): Promise<SystemBlock> {
  try {
    const full = await ownedImagePath(root, sessionId, image.path);
    if ((await lstat(full)).size > 8 * 1024 * 1024) throw new Error("oversize");
    const bytes = await readFile(full);
    if (bytes.length > 8 * 1024 * 1024) throw new Error("oversize");
    const info = sniffImage(bytes);
    if (!info) throw new Error("not an image");
    return (await captionStoredImage({ displayName: image.name, relPath: image.path, image: info, bytes },
      { lang, caption: null, deliver: true })).block;
  } catch {
    throw Object.assign(new Error("待发图片无法恢复，请移除后重新添加。"), { code: "image-unreadable" });
  }
}
