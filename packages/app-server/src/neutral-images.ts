import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  SystemBlock,
  TerminalRecord,
  TerminalRecordBlock,
} from "@herta/core";
import type { NeutralMessage } from "@herta/providers";
import type { MessageImage } from "@herta/providers/images";
import { ownedImagePath } from "./restore-staged-image.js";
import type { RoundPicture } from "./round-summary.js";

/**
 * Pictures the user attached, sent to the persona model as the pictures themselves (R77).
 *
 * The desktop's own connections have no captioning instrument, and a row that only names a
 * picture ("图片 JPEG · 1264×2780") left the model saying it received a file it could not see.
 * Each stored picture the record cites now rides the message that carries its row, as an image
 * block of the request's protocol — when the persona model can read images (`imageSupport`).
 * When it cannot, or the copy is gone, the row says so to the model; for the pictures of the
 * message being sent the turn stops with a reason instead of going out without them.
 * Since F02 a delegation hands the executor model its pictures the same way
 * (`planExecutorPictures`), judged by the executor's own image check. Since F02 design 2.8 a
 * persona model that cannot read images does not stop the message when the executor model can
 * be handed all of its pictures: the persona is told which ones a delegation hands over. Since
 * F04 a picture the user turned off (`modelUse: "stopped"`) goes to no model: its row stays and
 * says why, and it frees its room for an earlier picture.
 */

/** Turns stored bytes into a PNG or JPEG within the request limit; null when it cannot. */
export type ImagePreparer = (bytes: Buffer) => Promise<MessageImage | null>;

/** One turn's reads by stored path (F02): the executor's delegation is handed the very pictures
 *  the persona's plan read, not a second read and rescale of each. */
export type PictureCache = Map<string, Promise<MessageImage | null>>;

/** The providers' own request ceilings (protocols/encode.ts). */
export const MAX_REQUEST_IMAGES = 8;
export const MAX_REQUEST_IMAGE_CHARS = 12 * 1024 * 1024;
/** Per picture (images.ts `validateMessageImage`): 2 MB of PNG or JPEG. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Why a picture did not go: the model cannot read images, the copy is not sendable, the
 *  request was already full, or the user turned it off (F04). */
export type ImageMiss = "unsupported" | "unreadable" | "over_limit" | "stopped";

export interface ImageRow {
  readonly index: number;
  readonly path: string;
  /** F04: the user turned off sending it to models (`modelUse: "stopped"`). */
  readonly stopped: boolean;
}

/** A picture the record cites with a stored copy that was not taken back. */
export function imageRowOf(
  block: TerminalRecordBlock,
  index: number,
): ImageRow | null {
  if (block.kind !== "system") return null;
  const d = block.digest;
  if (d?.kind !== "attachment" || d.image === undefined || d.path === "")
    return null;
  // `no_caption`/`too_large` pictures are on disk and simply were not captioned; `removed`,
  // `denied` and the failed states have no copy to send.
  if (
    d.unreadable !== undefined &&
    d.unreadable !== "no_caption" &&
    d.unreadable !== "too_large"
  )
    return null;
  return { index, path: d.path, stopped: d.modelUse === "stopped" };
}

/** Whether a row's path is one of this session's own copies; with no session given, any is. */
function ownCopy(path: string, sessionId: string | undefined): boolean {
  return (
    sessionId === undefined ||
    path.startsWith(`.herta/attachments/${sessionId}/`)
  );
}

/** Only the session's own attachment copies (`.herta/attachments/<sid>/<file>`). */
function attachmentFile(root: string, relPath: string): string | null {
  const parts = relPath.split("/");
  if (
    parts.length !== 4 ||
    parts[0] !== ".herta" ||
    parts[1] !== "attachments" ||
    parts
      .slice(2)
      .some((p) => p === "" || p === "." || p === ".." || /[\\:]/.test(p))
  )
    return null;
  const full = resolve(root, ...parts);
  const within = relative(resolve(root), full);
  return within.startsWith("..") || isAbsolute(within) ? null : full;
}

function asIs(bytes: Buffer): MessageImage | null {
  if (bytes.length > MAX_IMAGE_BYTES) return null;
  const png = bytes.subarray(0, 8).equals(PNG);
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!png && !jpeg) return null;
  return {
    mimeType: png ? "image/png" : "image/jpeg",
    data: bytes.toString("base64"),
  };
}

/** The stored picture as the request will carry it, or null. */
export async function readPicture(
  root: string,
  relPath: string,
  prepare?: ImagePreparer,
): Promise<MessageImage | null> {
  const file = attachmentFile(root, relPath);
  if (file === null) return null;
  let bytes: Buffer;
  try {
    // A session-shaped path can still walk through a junction or symlink. Use
    // the same component checks as restored drafts before reading any bytes.
    const sessionId = relPath.split("/")[2] ?? "";
    const owned = await ownedImagePath(root, sessionId, relPath);
    bytes = await readFile(owned);
  } catch {
    return null;
  }
  const direct = asIs(bytes);
  if (direct !== null || prepare === undefined) return direct;
  try {
    const prepared = await prepare(bytes);
    // Whatever the preparer returns still has to be what the request accepts, and its type is
    // read from its bytes, not from its label.
    return prepared === null ? null : asIs(Buffer.from(prepared.data, "base64"));
  } catch {
    return null;
  }
}

export interface ImagePlan {
  readonly sent: ReadonlyMap<number, MessageImage>;
  readonly missed: ReadonlyMap<number, ImageMiss>;
  /** Set when a picture of the message being sent cannot go: the turn must stop. */
  readonly freshMiss?: ImageMiss;
}

/**
 * Which pictures this request carries. Rows at or after `freshFrom` belong to the message being
 * sent: every one goes, or the plan says why not. Earlier ones follow newest first while the
 * request has room — a model is shown what it was shown before, within the same ceilings. A
 * picture the user turned off (F04) goes to no model: it is never read, takes no room, and is not
 * one of the message's own, so it never stops the turn.
 */
export async function planImages(opts: {
  readonly record: TerminalRecord;
  readonly freshFrom: number;
  readonly supported: boolean;
  readonly root: string;
  readonly prepare?: ImagePreparer;
  readonly cache?: PictureCache;
  /** Only this session's own copies (`.herta/attachments/<sid>/`); any other row cannot go. */
  readonly sessionId?: string;
}): Promise<ImagePlan> {
  const read = (path: string): Promise<MessageImage | null> => {
    if (!ownCopy(path, opts.sessionId)) return Promise.resolve(null);
    let pending = opts.cache?.get(path);
    if (pending === undefined) {
      pending = readPicture(opts.root, path, opts.prepare);
      opts.cache?.set(path, pending);
    }
    return pending;
  };
  const rows = opts.record.flatMap((b, i) => {
    const row = imageRowOf(b, i);
    return row ? [row] : [];
  });
  const sent = new Map<number, MessageImage>();
  const missed = new Map<number, ImageMiss>();
  for (const r of rows) if (r.stopped) missed.set(r.index, "stopped");
  const live = rows.filter((r) => !r.stopped);
  const fresh = live.filter((r) => r.index >= opts.freshFrom);
  const earlier = live.filter((r) => r.index < opts.freshFrom).reverse();
  if (!opts.supported) {
    for (const r of live) missed.set(r.index, "unsupported");
    return {
      sent,
      missed,
      ...(fresh.length ? { freshMiss: "unsupported" as const } : {}),
    };
  }
  let chars = 0;
  let freshMiss: ImageMiss | undefined;
  for (const [i, r] of [...fresh, ...earlier].entries()) {
    const isFresh = i < fresh.length;
    if (isFresh && fresh.length > MAX_REQUEST_IMAGES) {
      missed.set(r.index, "over_limit");
      freshMiss ??= "over_limit";
      continue;
    }
    if (sent.size >= MAX_REQUEST_IMAGES) {
      missed.set(r.index, "over_limit");
      continue;
    }
    const image = await read(r.path);
    if (image === null) {
      missed.set(r.index, "unreadable");
      if (isFresh) freshMiss ??= "unreadable";
      continue;
    }
    if (chars + image.data.length > MAX_REQUEST_IMAGE_CHARS) {
      missed.set(r.index, "over_limit");
      if (isFresh) freshMiss ??= "over_limit";
      continue;
    }
    chars += image.data.length;
    sent.set(r.index, image);
  }
  return { sent, missed, ...(freshMiss ? { freshMiss } : {}) };
}

/** F04: the stored copies the user turned off, by path — the way a journal names its pictures. */
export function stoppedPaths(record: TerminalRecord): ReadonlySet<string> {
  return new Set(
    record.flatMap((b, i) => {
      const row = imageRowOf(b, i);
      return row?.stopped ? [row.path] : [];
    }),
  );
}

/** F04: a plan as the round's evidence, row by row in record order: what went, and why the others
 *  did not. */
export function pictureOutcomes(
  record: TerminalRecord,
  plan: ImagePlan,
): RoundPicture[] {
  return record.flatMap((b, i) => {
    const row = imageRowOf(b, i);
    const outcome = plan.sent.has(i) ? "sent" : plan.missed.get(i);
    return row && outcome ? [{ index: i, path: row.path, outcome }] : [];
  });
}

const MISSED: Record<ImageMiss, string> = {
  unsupported: "the current model is not verified for image input",
  unreadable:
    "its stored copy is missing, or is not a PNG or JPEG that fits the 2 MB request limit",
  over_limit: "a request carries at most 8 pictures, and newer ones took the room",
  stopped: "the user turned off sending it to models",
};

const ATTACHED = "\nThe picture itself is attached to this message.";

/** A picture row as a model reads it. Rows stored before R77 say "未能读图"; that was about
 *  captioning, not about any request. */
function rowText(block: SystemBlock): string {
  return block.body.replace(" · 已存图片，未能读图", "");
}

/** F02 design 2.8: a picture the persona is not shown that a delegation hands the executor. */
const HANDED_ON =
  " The executor model is verified for image input and is handed this picture with a delegation: delegate work that depends on what it shows.";

/** What the model reads for a picture row: the row, then whether the picture is attached, and
 *  whether one it is not shown reaches the executor (`handedOn`). */
export function pictureText(
  block: SystemBlock,
  sent: boolean,
  miss?: ImageMiss,
  handedOn = false,
): string {
  const row = rowText(block);
  return sent
    ? `[User attachment: picture]\n${row}${ATTACHED}`
    : `[User attachment: picture, not sent]\n${row}\nThe picture was not sent to you (${MISSED[miss ?? "unreadable"]}).${handedOn ? HANDED_ON : ""} Do not guess what it shows; if asked, say you cannot see it.`;
}

/** The executor's reasons (F02): there, its own model is the one that may not read images. */
const EXECUTOR_MISSED: Record<ImageMiss, string> = {
  ...MISSED,
  unsupported: "the executor model is not verified for image input",
};

/** Rows of pictures the executor is not shown that its request lists, newest kept: its task
 *  context is bounded (ADR 0025), and a long task's pictures must not grow every request. */
const LISTED_UNSENT = MAX_REQUEST_IMAGES;

const countOf = (n: number) => `${n} ${n === 1 ? "picture" : "pictures"}`;

/** What the executor reads with a picture it is handed (F02). */
function executorSent(block: SystemBlock): string {
  return `[User attachment: picture]\n${rowText(block)}${ATTACHED} It is the file the task history cites at that path; look at it here, since file tools cannot show you a picture.`;
}

/** One message for every picture the executor is not shown (F02). It talks to no one: a picture
 *  it was not shown must not be guessed at, and the persona's words about one are hers. */
function executorUnsent(
  unsent: readonly { readonly block: SystemBlock; readonly miss: ImageMiss }[],
): string {
  const listed = unsent.slice(-LISTED_UNSENT);
  const older = unsent.length - listed.length;
  const counts = new Map<ImageMiss, number>();
  for (const u of unsent) counts.set(u.miss, (counts.get(u.miss) ?? 0) + 1);
  const why = [...counts]
    .map(([miss, n]) => `${n} because ${EXECUTOR_MISSED[miss]}`)
    .join("; ");
  return [
    `[User attachments: ${countOf(unsent.length)} not sent to you]`,
    ...listed.map((u) => rowText(u.block)),
    ...(older > 0
      ? [`(and ${older} older ${older === 1 ? "one" : "ones"})`]
      : []),
    `Not sent: ${why}. A picture not attached to a message here was not sent to you: do not guess what it shows, and do not try to view it with file tools. What The Herta persona said about it in the recent dialogue is her description, not something you saw; say what you could not verify.`,
  ].join("\n");
}

export interface ExecutorPictures {
  /** Each picture the executor is handed, in record order, as the message carrying its row; then
   *  one message naming the newest of those it is not, with the reasons. */
  readonly messages: readonly NeutralMessage[];
  /** Pictures withheld because the executor model is not verified for image input. */
  readonly unsupported: number;
  /** F04: the round's evidence for this delegation, row by row. */
  readonly outcomes: readonly RoundPicture[];
}

/**
 * The pictures one delegation hands the executor model (F02): chosen as the persona's are — the
 * message's own first, then earlier ones newest first, within the same ceilings — but judged by
 * the executor binding's own image check (`supported`), and only from this session's copies.
 * Nothing stops here: the message's pictures were shown to the persona (R77) or, when only the
 * executor model is verified for images, checked to go to it (F02 design 2.8); so what cannot go
 * is said to the executor instead.
 */
export async function planExecutorPictures(opts: {
  readonly record: TerminalRecord;
  readonly freshFrom: number;
  readonly supported: boolean;
  readonly root: string;
  readonly sessionId: string;
  readonly prepare?: ImagePreparer;
  readonly cache?: PictureCache;
}): Promise<ExecutorPictures> {
  const plan = await planImages(opts);
  const messages: NeutralMessage[] = [];
  const unsent: { readonly block: SystemBlock; readonly miss: ImageMiss }[] =
    [];
  for (const [index, block] of opts.record.entries()) {
    if (block.kind !== "system") continue;
    const image = plan.sent.get(index);
    const miss = plan.missed.get(index);
    if (image !== undefined)
      messages.push({
        role: "user",
        text: executorSent(block),
        images: [image],
      });
    else if (miss !== undefined) unsent.push({ block, miss });
  }
  if (unsent.length > 0)
    messages.push({ role: "user", text: executorUnsent(unsent) });
  return {
    messages,
    unsupported: unsent.filter((u) => u.miss === "unsupported").length,
    outcomes: pictureOutcomes(opts.record, plan),
  };
}

/** A journal keeps where a picture is, never its bytes (`user-input.json` is plain JSON). */
export type JournalMessage = NeutralMessage & {
  readonly imageRefs?: readonly string[];
};

export function forJournal(
  messages: readonly NeutralMessage[],
  refs: ReadonlyMap<NeutralMessage, readonly string[]>,
): JournalMessage[] {
  return messages.map((m) =>
    m.role === "user" && m.images?.length
      ? { role: "user", text: m.text, imageRefs: refs.get(m) ?? [] }
      : m,
  );
}

/** Put the pictures back into journalled messages; one that cannot go is said in the text. One
 *  the user turned off since the journal was written (F04, `stopped` by path) is not read again. */
export async function fromJournal(
  messages: readonly JournalMessage[],
  opts: {
    readonly supported: boolean;
    readonly root: string;
    readonly prepare?: ImagePreparer;
    readonly refs: Map<NeutralMessage, readonly string[]>;
    readonly stopped?: ReadonlySet<string>;
    /** Only this session's own copies, as `planImages` takes them. */
    readonly sessionId?: string;
  },
): Promise<NeutralMessage[]> {
  let count = 0;
  let chars = 0;
  const out: NeutralMessage[] = [];
  for (const m of messages) {
    if (m.role !== "user" || !m.imageRefs?.length) {
      out.push(m);
      continue;
    }
    const images: MessageImage[] = [];
    let miss: ImageMiss | undefined;
    for (const ref of m.imageRefs) {
      if (opts.stopped?.has(ref)) {
        miss = "stopped";
        continue;
      }
      if (!opts.supported) {
        miss = "unsupported";
        break;
      }
      const image =
        count < MAX_REQUEST_IMAGES && ownCopy(ref, opts.sessionId)
          ? await readPicture(opts.root, ref, opts.prepare)
          : null;
      if (image === null || chars + image.data.length > MAX_REQUEST_IMAGE_CHARS) {
        miss = image === null && count < MAX_REQUEST_IMAGES ? "unreadable" : "over_limit";
        continue;
      }
      count++;
      chars += image.data.length;
      images.push(image);
    }
    const message: NeutralMessage = images.length
      ? {
          role: "user",
          text: miss ? `${m.text}\n(Some pictures were not sent: ${MISSED[miss]}.)` : m.text,
          images,
        }
      : {
          role: "user",
          text: `${m.text.replace(ATTACHED, "")}\nThe picture was not sent to you (${MISSED[miss ?? "unreadable"]}). Do not guess what it shows; if asked, say you cannot see it.`,
        };
    if (images.length) opts.refs.set(message, m.imageRefs);
    out.push(message);
  }
  return out;
}
