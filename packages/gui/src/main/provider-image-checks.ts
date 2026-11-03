import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { writeFileAtomicSync } from "@herta/core";
import type {
  CapabilitySupport,
  ProviderConfig,
  ProviderSettings,
} from "@herta/providers";
import type { ImageRequestRefused } from "@herta/providers/images";
import { app } from "electron";
import type { ImageCheckView } from "../shared/provider-settings-ipc.js";

/**
 * R109 (F06): when an image check ran and on which connection. provider-settings.json rejects
 * unknown fields, so a date added there would make the settings unreadable after a rollback to
 * an older version; this file sits beside it, and older versions never open it.
 *
 * `capabilities.images` in the settings stays the only source of the result. A record describes
 * it only while it names that same result on the same connection — protocol, address,
 * authentication and stored key, the test R83 uses to keep results across a save — so a record
 * left behind by a rollback, a re-added model or a changed connection is never shown as current.
 *
 * Forward compatible: unknown fields and entries are kept on rewrite and ignored on read. Only a
 * file that is not this format at all is unreadable, and that file is never overwritten (R98's
 * rule for the pending-image manifest); the user's explicit reset moves it to a new name.
 */
const recordsPath = () =>
  join(app.getPath("userData"), "provider-image-checks.json");

interface ImageCheckRecord {
  readonly result: "supported" | "unsupported";
  readonly checkedAt: string;
  /** The settings revision the probe ran against; informational, a save that keeps the
   *  connection moves the result to a later revision. */
  readonly providerRevision: number;
  readonly protocol: ProviderConfig["protocol"];
  readonly connection: string;
}
/** R110: a request that carried pictures was refused (HTTP 400/415/422), cause unknown. Shown
 *  only while it is about the current result on the current connection and no image check has
 *  been made since; a conclusive check removes it. Adding it kept schemaVersion 1. */
interface ImageReviewRecord {
  readonly at: string;
  readonly status: number;
  readonly surface: "chat" | "workbench";
  /** `capabilities.images` when the request was refused. */
  readonly images: CapabilitySupport;
  readonly providerRevision: number;
  readonly protocol: ProviderConfig["protocol"];
  readonly connection: string;
}
interface RecordsFile {
  readonly [key: string]: unknown;
  readonly schemaVersion: 1;
  readonly entries: readonly unknown[];
}

/** The connection a result was measured on, without storing the address or key reference. */
export function connectionFingerprint(
  p: Pick<
    ProviderConfig,
    | "protocol"
    | "baseURL"
    | "authentication"
    | "allowRemoteHTTP"
    | "credentialRef"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        p.protocol,
        p.baseURL,
        p.authentication,
        p.allowRemoteHTTP,
        p.credentialRef,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

class UnreadableImageChecks extends Error {}
/** Null when there is no file yet. */
function read(): RecordsFile | null {
  if (!existsSync(recordsPath())) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(recordsPath(), "utf8"));
  } catch {
    throw new UnreadableImageChecks();
  }
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    (data as RecordsFile).schemaVersion !== 1 ||
    !Array.isArray((data as RecordsFile).entries)
  )
    throw new UnreadableImageChecks();
  return data as RecordsFile;
}
function entryOf(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  return typeof fields.providerId === "string" &&
    typeof fields.modelId === "string"
    ? { providerId: fields.providerId, modelId: fields.modelId, fields }
    : null;
}
function imageRecord(value: unknown): ImageCheckRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  return (r.result === "supported" || r.result === "unsupported") &&
    typeof r.checkedAt === "string" &&
    !Number.isNaN(Date.parse(r.checkedAt)) &&
    Number.isInteger(r.providerRevision) &&
    (r.providerRevision as number) >= 1 &&
    typeof r.protocol === "string" &&
    typeof r.connection === "string"
    ? (r as unknown as ImageCheckRecord)
    : null;
}
const REFUSED = [400, 415, 422];
function reviewRecord(value: unknown): ImageReviewRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  return typeof r.at === "string" &&
    !Number.isNaN(Date.parse(r.at)) &&
    REFUSED.includes(r.status as number) &&
    (r.surface === "chat" || r.surface === "workbench") &&
    (r.images === "unknown" ||
      r.images === "supported" ||
      r.images === "unsupported") &&
    Number.isInteger(r.providerRevision) &&
    (r.providerRevision as number) >= 1 &&
    typeof r.protocol === "string" &&
    typeof r.connection === "string"
    ? (r as unknown as ImageReviewRecord)
    : null;
}

/** For the settings view; never throws. */
export function imageCheckViews(settings: ProviderSettings): {
  imageChecks: ImageCheckView[];
  imageCheckIssue?: "unreadable";
} {
  let file: RecordsFile | null;
  try {
    file = read();
  } catch {
    return { imageChecks: [], imageCheckIssue: "unreadable" };
  }
  const imageChecks: ImageCheckView[] = [];
  for (const item of file?.entries ?? []) {
    const entry = entryOf(item);
    if (!entry) continue;
    const images = imageRecord(entry.fields.images);
    const review = reviewRecord(entry.fields.imageReview);
    if (!images && !review) continue;
    const provider = settings.providers.find((p) => p.id === entry.providerId);
    const model = provider?.models.find((m) => m.id === entry.modelId);
    if (!provider || !model) continue;
    if (
      imageChecks.some(
        (c) => c.providerId === provider.id && c.modelId === model.id,
      )
    )
      continue;
    const connection = connectionFingerprint(provider);
    const onThisConnection = (r: { connection: string; protocol: string }) =>
      r.connection === connection && r.protocol === provider.protocol;
    let checkedAt: string | undefined;
    let connectionChanged = false;
    if (images && onThisConnection(images)) {
      // Otherwise the result was saved since by something that did not date it.
      if (images.result === model.capabilities.images)
        checkedAt = images.checkedAt;
    } else if (images && model.capabilities.images === "unknown")
      connectionChanged = true;
    // A check made at or after the refusal answers it, even one an older version made: R109 kept
    // the review when it rewrote the entry.
    const pending =
      review &&
      onThisConnection(review) &&
      review.images === model.capabilities.images &&
      !(images && Date.parse(images.checkedAt) >= Date.parse(review.at))
        ? review
        : null;
    if (!checkedAt && !connectionChanged && !pending) continue;
    imageChecks.push({
      providerId: provider.id,
      modelId: model.id,
      ...(checkedAt ? { checkedAt } : {}),
      ...(connectionChanged ? { connectionChanged: true as const } : {}),
      ...(pending
        ? {
            review: {
              at: pending.at,
              status: pending.status,
              surface: pending.surface,
            },
          }
        : {}),
    });
  }
  return { imageChecks };
}

/** Replaces the (providerId, modelId) entry with `next(its fields)`. Entries of deleted connections
 *  and models are dropped; ones not recognisably ours are kept exactly as they were. Throws when
 *  the file is unreadable or cannot be written. */
function writeEntry(
  settings: ProviderSettings,
  providerId: string,
  modelId: string,
  next: (previous: Record<string, unknown>) => Record<string, unknown>,
): void {
  const file = read();
  let previous: Record<string, unknown> | undefined;
  const entries: unknown[] = [];
  for (const item of file?.entries ?? []) {
    const entry = entryOf(item);
    // Not recognisably ours to judge: kept exactly as it was.
    if (!entry) entries.push(item);
    else if (entry.providerId === providerId && entry.modelId === modelId)
      previous ??= entry.fields;
    else if (
      settings.providers.some(
        (p) =>
          p.id === entry.providerId &&
          p.models.some((m) => m.id === entry.modelId),
      )
    )
      entries.push(item);
  }
  entries.push({ providerId, modelId, ...next(previous ?? {}) });
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileAtomicSync(
    recordsPath(),
    `${JSON.stringify({ ...file, schemaVersion: 1, entries }, null, 2)}\n`,
  );
}
const unwritten = (error: unknown) =>
  error instanceof UnreadableImageChecks
    ? "unreadable record file"
    : (error as Error)?.name;

/**
 * Dates the image result a probe has just saved in `settings`. False when nothing was written —
 * the file is unreadable, the write failed, or `settings` no longer hold that result; the result
 * itself stands either way. Entries of deleted connections and models are dropped here.
 */
export function recordImageCheck(
  settings: ProviderSettings,
  providerId: string,
  modelId: string,
  result: ImageCheckRecord["result"],
  now = new Date(),
): boolean {
  const provider = settings.providers.find((p) => p.id === providerId);
  const model = provider?.models.find((m) => m.id === modelId);
  if (!provider || model?.capabilities.images !== result) return false;
  try {
    const images: ImageCheckRecord = {
      result,
      checkedAt: now.toISOString(),
      providerRevision: provider.revision,
      protocol: provider.protocol,
      connection: connectionFingerprint(provider),
    };
    writeEntry(settings, providerId, modelId, (previous) => {
      const fields: Record<string, unknown> = { ...previous, images };
      // R110: a conclusive check answers a pending review.
      delete fields.imageReview;
      return fields;
    });
    return true;
  } catch (error) {
    console.warn("[herta] image check date not recorded:", unwritten(error));
    return false;
  }
}

/**
 * R110 (F06): a request that carried pictures was refused, so the model is marked for an image
 * re-check. Its result is not touched — the cause is not known. False when nothing was written:
 * the connection was saved since the request (another revision), the model is gone, the report is
 * not a refusal this file records, or the file is unreadable or could not be written.
 */
export function recordImageReview(
  settings: ProviderSettings,
  refused: ImageRequestRefused,
  now = new Date(),
): boolean {
  const provider = settings.providers.find((p) => p.id === refused.providerId);
  const model = provider?.models.find((m) => m.id === refused.modelId);
  if (
    !provider ||
    !model ||
    provider.revision !== refused.providerRevision ||
    !REFUSED.includes(refused.status) ||
    (refused.surface !== "chat" && refused.surface !== "workbench")
  )
    return false;
  try {
    const imageReview: ImageReviewRecord = {
      at: now.toISOString(),
      status: refused.status,
      surface: refused.surface,
      images: model.capabilities.images,
      providerRevision: provider.revision,
      protocol: provider.protocol,
      connection: connectionFingerprint(provider),
    };
    writeEntry(settings, provider.id, model.id, (previous) => ({
      ...previous,
      imageReview,
    }));
    return true;
  } catch (error) {
    console.warn("[herta] image review not recorded:", unwritten(error));
    return false;
  }
}

/** The user's explicit reset of an unreadable record file: its bytes move to a new name beside
 *  it and are never rewritten or deleted. A readable file is refused. */
export function quarantineImageChecks(now = new Date()): string {
  let readable = true;
  try {
    read();
  } catch {
    readable = false;
  }
  if (readable) throw new Error("识图验证记录可以正常读取，无需重置。");
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let backup = `${recordsPath()}.damaged-${stamp}`;
  for (let n = 2; existsSync(backup); n++)
    backup = `${recordsPath()}.damaged-${stamp}-${n}`;
  renameSync(recordsPath(), backup);
  return basename(backup);
}
