import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Re-verify an installed voice-model bundle against the `manifest.json`
 * inside it (ADR 0061 — the same check `scripts/tts-bundle.mjs --verify`
 * runs from the command line, here for the download path: an extracted
 * archive becomes the bundle only after every file's size and SHA-256 match
 * and the release id is the one this build expects).
 */
export interface BundleManifestFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface BundleManifest {
  readonly schema: number;
  readonly release: string;
  readonly model: string;
  readonly runtime_voice: string;
  readonly files: readonly BundleManifestFile[];
}

export type BundleVerifyResult =
  | { readonly ok: true; readonly files: number; readonly bytes: number }
  | { readonly ok: false; readonly reason: string };

export function isManifest(v: unknown): v is BundleManifest {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.release === "string" &&
    typeof m.model === "string" &&
    Array.isArray(m.files) &&
    m.files.every(
      (f) =>
        typeof f === "object" &&
        f !== null &&
        typeof (f as BundleManifestFile).path === "string" &&
        typeof (f as BundleManifestFile).bytes === "number" &&
        typeof (f as BundleManifestFile).sha256 === "string",
    )
  );
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export async function readBundleManifest(
  root: string,
): Promise<BundleManifest | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(root, "manifest.json"), "utf8"),
    );
    return isManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function verifyBundle(
  root: string,
  expectedRelease: string,
): Promise<BundleVerifyResult> {
  const manifest = await readBundleManifest(root);
  if (manifest === null) return { ok: false, reason: "no readable manifest" };
  if (manifest.release !== expectedRelease) {
    return {
      ok: false,
      reason: `release "${manifest.release}" is not "${expectedRelease}"`,
    };
  }
  if (manifest.files.length === 0)
    return { ok: false, reason: "empty manifest" };
  let bytes = 0;
  for (const f of manifest.files) {
    if (f.path.split("/").some((s) => s === "" || s === "." || s === "..")) {
      return { ok: false, reason: `bad manifest path ${f.path}` };
    }
    const p = join(root, ...f.path.split("/"));
    let size: number;
    try {
      const st = await stat(p);
      if (!st.isFile()) return { ok: false, reason: `${f.path} is not a file` };
      size = st.size;
    } catch {
      return { ok: false, reason: `missing ${f.path}` };
    }
    if (size !== f.bytes) return { ok: false, reason: `${f.path}: size` };
    if ((await sha256File(p)) !== f.sha256) {
      return { ok: false, reason: `${f.path}: hash` };
    }
    bytes += size;
  }
  return { ok: true, files: manifest.files.length, bytes };
}
