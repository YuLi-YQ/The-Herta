import { validateChatAttachments, type ChatAttachment } from "../../shared/herta-chat.js";

/**
 * The independent chat's pending attachments, kept between launches (R101).
 *
 * Until R100 the files a chat had not sent yet lived only in the window's memory (R70), so a
 * restart dropped them while the draft beside them came back. They are bytes — a picture is
 * up to 2 MB, four files a message — so they go to IndexedDB, never to localStorage: one
 * record per chat, replaced whole in one transaction, removed when the list empties.
 *
 * Reading never parses, uploads or sends anything. A record this build cannot use (damaged,
 * or written by another version) is kept: a write refuses to replace it, and only an explicit
 * set-aside moves it to a separate store. Nothing here deletes one. Cards for files that are
 * still being read or were refused hold a File, not attachment data: they are kept apart, as
 * names and reasons only (pending-attach-issues, R102).
 */

/** Why storage did not do what was asked. The surface owns the words (no-hardcoded-cjk).
 *  "unsupported": no IndexedDB at all (tests; Electron always has one) — files stay in memory. */
export type PendingChatProblem =
  | "unsupported"
  | "unavailable"
  | "unreadable"
  | "not_overwritten"
  | "not_saved";

export interface PendingChatRead {
  readonly files: ChatAttachment[];
  readonly problem?: "unsupported" | "unavailable" | "unreadable";
}

const DB_NAME = "herta-chat-pending";
const STORE = "pending";
/** Records the reader refused, moved here by setAside and never read back by the app. */
const ASIDE = "set-aside";
const VERSION = 1;

interface StoredRecord {
  readonly version: typeof VERSION;
  readonly chatId: string;
  readonly files: readonly ChatAttachment[];
}

/** Written by this format for this chat. Enough to tell a write whether it may replace it:
 *  the full check below ran when the chat read the record. */
function ownRecord(record: unknown, chatId: string): record is StoredRecord {
  if (typeof record !== "object" || record === null) return false;
  const r = record as Partial<StoredRecord>;
  return r.version === VERSION && r.chatId === chatId && Array.isArray(r.files);
}

/** The files of a stored record, or null when this build cannot use it. Pending files carry
 *  their data inline: a history reference (imageRef/imageMissing) or a deferred preview never
 *  belongs here, so a record with one is refused rather than sent without its picture. */
export function pendingChatRecordFiles(record: unknown, chatId: string): ChatAttachment[] | null {
  if (!ownRecord(record, chatId)) return null;
  const borrowed = (file: unknown) =>
    typeof file !== "object" ||
    file === null ||
    ["imageRef", "imageMissing", "imageDeferred"].some(
      (key) => (file as Record<string, unknown>)[key] !== undefined,
    );
  if (record.files.some(borrowed)) return null;
  try {
    return validateChatAttachments(record.files);
  } catch {
    return null;
  }
}

function openDb(idb: IDBFactory): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (db: IDBDatabase | null) => {
      // A blocked open may still succeed later; that connection is not used.
      if (settled) {
        db?.close();
        return;
      }
      settled = true;
      resolve(db);
    };
    try {
      const open = idb.open(DB_NAME, VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        if (!db.objectStoreNames.contains(ASIDE))
          db.createObjectStore(ASIDE, { autoIncrement: true });
      };
      open.onsuccess = () => settle(open.result);
      open.onerror = () => settle(null);
      open.onblocked = () => settle(null);
    } catch {
      settle(null);
    }
  });
}

async function readRecord(idb: IDBFactory, chatId: string): Promise<PendingChatRead> {
  const db = await openDb(idb);
  if (db === null) return { files: [], problem: "unavailable" };
  const got = await new Promise<{ value: unknown } | null>((resolve) => {
    try {
      const get = db.transaction(STORE, "readonly").objectStore(STORE).get(chatId);
      get.onsuccess = () => resolve({ value: get.result });
      get.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  db.close();
  if (got === null) return { files: [], problem: "unavailable" };
  if (got.value === undefined) return { files: [] };
  const files = pendingChatRecordFiles(got.value, chatId);
  return files === null ? { files: [], problem: "unreadable" } : { files };
}

/** Runs `body` in one readwrite transaction over `stores`. Settles with undefined once it
 *  commits; when it aborts, with the problem the body refused with, or "not_saved". */
async function change(
  idb: IDBFactory,
  stores: string[],
  body: (tx: IDBTransaction, refuse: (problem: PendingChatProblem) => void) => void,
): Promise<PendingChatProblem | undefined> {
  const db = await openDb(idb);
  if (db === null) return "unavailable";
  const result = await new Promise<PendingChatProblem | undefined>((resolve) => {
    let refused: PendingChatProblem | undefined;
    try {
      // Attachments are what the person chose to send: ask for the write to reach the disk.
      const tx = db.transaction(stores, "readwrite", { durability: "strict" });
      tx.oncomplete = () => resolve(undefined);
      tx.onabort = () => resolve(refused ?? "not_saved");
      body(tx, (problem) => {
        refused = problem;
        tx.abort();
      });
    } catch {
      resolve("not_saved");
    }
  });
  db.close();
  return result;
}

/** Replaces the chat's record with `files`, or removes it for an empty list — in the same
 *  transaction that checked the record there is one this format wrote for this chat. */
function saveRecord(idb: IDBFactory, chatId: string, files: readonly ChatAttachment[]) {
  return change(idb, [STORE], (tx, refuse) => {
    const store = tx.objectStore(STORE);
    const get = store.get(chatId);
    get.onsuccess = () => {
      if (get.result !== undefined && !ownRecord(get.result, chatId))
        return refuse("not_overwritten");
      if (files.length === 0) store.delete(chatId);
      else store.put({ version: VERSION, chatId, files: [...files] } satisfies StoredRecord, chatId);
    };
  });
}

/** Moves the chat's record, whatever it holds, to the set-aside store in one transaction. */
function setAsideRecord(idb: IDBFactory, chatId: string) {
  return change(idb, [STORE, ASIDE], (tx) => {
    const store = tx.objectStore(STORE);
    const get = store.get(chatId);
    get.onsuccess = () => {
      if (get.result === undefined) return;
      tx.objectStore(ASIDE).add({ chatId, at: new Date().toISOString(), record: get.result });
      store.delete(chatId);
    };
  });
}

export interface PendingChatStore {
  read(chatId: string): Promise<PendingChatRead>;
  /** Saves `files` as the chat's whole pending list. One chat's operations run in the order
   *  asked; writes still waiting their turn collapse into the latest list. */
  write(chatId: string, files: readonly ChatAttachment[]): Promise<PendingChatProblem | undefined>;
  /** Moves a record the chat could not read out of the way, keeping it. */
  setAside(chatId: string): Promise<PendingChatProblem | undefined>;
}

interface Waiting {
  files: readonly ChatAttachment[];
  done: Promise<PendingChatProblem | undefined>;
}

/** One queue per IndexedDB, not per store: a chat mounted again reads after the writes its
 *  earlier mount asked for. */
const queues = new WeakMap<
  IDBFactory,
  { tails: Map<string, Promise<unknown>>; waiting: Map<string, Waiting> }
>();

export function pendingChatStore(
  idb: IDBFactory | undefined = globalThis.indexedDB,
): PendingChatStore {
  if (idb === undefined)
    return {
      read: () => Promise.resolve({ files: [], problem: "unsupported" }),
      write: () => Promise.resolve("unsupported"),
      setAside: () => Promise.resolve("unsupported"),
    };
  let shared = queues.get(idb);
  if (!shared) {
    shared = { tails: new Map(), waiting: new Map() };
    queues.set(idb, shared);
  }
  const { tails, waiting } = shared;
  const queue = <T>(chatId: string, task: () => Promise<T>): Promise<T> => {
    const done = (tails.get(chatId) ?? Promise.resolve()).then(task);
    tails.set(chatId, done.catch(() => undefined));
    return done;
  };
  return {
    read(chatId) {
      waiting.delete(chatId); // a later write must wait for this read
      return queue(chatId, () => readRecord(idb, chatId));
    },
    write(chatId, files) {
      const queued = waiting.get(chatId);
      if (queued) {
        queued.files = files;
        return queued.done;
      }
      const entry: Waiting = { files, done: Promise.resolve(undefined) };
      entry.done = queue(chatId, () => {
        if (waiting.get(chatId) === entry) waiting.delete(chatId);
        return saveRecord(idb, chatId, entry.files);
      });
      waiting.set(chatId, entry);
      return entry.done;
    },
    setAside(chatId) {
      waiting.delete(chatId);
      return queue(chatId, () => setAsideRecord(idb, chatId));
    },
  };
}
