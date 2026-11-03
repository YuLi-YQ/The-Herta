import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SystemBlock,
  TerminalRecord,
  TerminalRecordBlock,
} from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  fromJournal,
  type ImagePlan,
  type JournalMessage,
  pictureOutcomes,
  planExecutorPictures,
  planImages,
  stoppedPaths,
} from "./neutral-images.js";
import { RoundStore } from "./round-store.js";
import type { RoundPicture } from "./round-summary.js";
import { SessionAttachments } from "./session-attachments.js";
import { removeTmpDir } from "./testing/tmp-workspace.js";

// F04 (R115): pictures the user turned off — the plan, an answered question's continuation, the
// round's evidence and the session's command. Units with stored copies on disk and a fake driver;
// the requests a session sends are covered in neutral-executor-pictures.test.ts.

/** A 1×1 PNG; `picture(n)` is the same picture with one trailing byte, so each has its own hash. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);
const picture = (n: number) => Buffer.concat([PNG, Buffer.from([n])]);
const STOPPED = "the user turned off sending it to models";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTmpDir(root);
});

const path = (name: string) => `.herta/attachments/s1/${name}`;

function row(
  name: string,
  opts: { readonly stopped?: boolean; readonly removed?: boolean } = {},
): SystemBlock {
  return {
    kind: "system",
    label: "系统",
    body: `附件 ${name} · 图片 PNG · 1×1 · ${path(name)}`,
    digest: {
      kind: "attachment",
      name,
      path: path(name),
      lines: 0,
      chars: 0,
      image: { format: "png", width: 1, height: 1 },
      ...(opts.removed ? { unreadable: "removed" as const } : {}),
      ...(opts.stopped ? { modelUse: "stopped" as const } : {}),
    },
  };
}
const noteRow: SystemBlock = {
  kind: "system",
  label: "系统",
  body: `附件 notes.md · 1 行 · ${path("notes.md")}`,
  digest: {
    kind: "attachment",
    name: "notes.md",
    path: path("notes.md"),
    lines: 1,
    chars: 8,
  },
};

/** A workspace holding `names` as this session's stored copies, each with its own bytes. */
function workspace(names: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "herta-f04-"));
  roots.push(root);
  mkdirSync(join(root, ".herta", "attachments", "s1"), { recursive: true });
  names.forEach((name, n) => {
    writeFileSync(join(root, ...path(name).split("/")), picture(n));
  });
  return root;
}
const sentRows = (plan: ImagePlan) =>
  [...plan.sent.keys()].sort((a, b) => a - b);
const missedRows = (plan: ImagePlan) => Object.fromEntries(plan.missed);
const textOf = (
  m: { readonly role: string; readonly text?: string } | undefined,
) => (m?.role === "user" ? (m.text ?? "") : "");

describe("pictures the user turned off (F04): which pictures a request carries", () => {
  it("never reads a turned-off picture and gives it no room: turning off the newest of nine lets the oldest go", async () => {
    const nine = Array.from({ length: 9 }, (_, n) => `p${n + 1}.png`);
    const root = workspace(nine);
    const plain: TerminalRecord = [
      { kind: "user", text: "看图" },
      ...nine.map((name) => row(name)),
    ];
    const opts = { freshFrom: plain.length + 1, supported: true, root };
    const ceiling = await planImages({ record: plain, ...opts });
    expect(sentRows(ceiling)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(missedRows(ceiling)).toEqual({ 1: "over_limit" });
    // p9 turned off, and gone.png too — with no stored copy: read, it would be `unreadable`.
    const chosen: TerminalRecord = [
      ...plain.slice(0, 9),
      row("p9.png", { stopped: true }),
      row("gone.png", { stopped: true }),
    ];
    const plan = await planImages({ record: chosen, ...opts });
    expect(sentRows(plan)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(missedRows(plan)).toEqual({ 9: "stopped", 10: "stopped" });
    expect(plan.freshMiss).toBeUndefined();
  });

  it("a turned-off picture of the message being sent does not stop the turn, whatever the model", async () => {
    const root = workspace(["a.png", "b.png"]);
    const record: TerminalRecord = [
      { kind: "user", text: "看图" },
      row("a.png", { stopped: true }),
    ];
    for (const supported of [true, false]) {
      const plan = await planImages({ record, freshFrom: 1, supported, root });
      expect(plan.freshMiss).toBeUndefined();
      expect(plan.sent.size).toBe(0);
      expect(missedRows(plan)).toEqual({ 1: "stopped" });
    }
    // Beside one that is not turned off, the model's reason stands for that one (R77).
    const blind = await planImages({
      record: [...record, row("b.png")],
      freshFrom: 1,
      supported: false,
      root,
    });
    expect(blind.freshMiss).toBe("unsupported");
    expect(missedRows(blind)).toEqual({ 1: "stopped", 2: "unsupported" });
  });

  it("a delegation lists a turned-off picture as not sent, with the user's reason, apart from the model's", async () => {
    const root = workspace(["a.png", "b.png"]);
    const record: TerminalRecord = [
      { kind: "user", text: "看图" },
      row("a.png"),
      row("b.png", { stopped: true }),
    ];
    const opts = { record, freshFrom: record.length, root, sessionId: "s1" };
    const blind = await planExecutorPictures({ ...opts, supported: false });
    // Only the model's own reason counts for the record's "not verified" note.
    expect(blind.unsupported).toBe(1);
    expect(blind.messages).toHaveLength(1);
    const none = textOf(blind.messages[0]);
    expect(none).toContain("[User attachments: 2 pictures not sent to you]");
    expect(none).toContain(
      "1 because the executor model is not verified for image input",
    );
    expect(none).toContain(`1 because ${STOPPED}`);
    const seeing = await planExecutorPictures({ ...opts, supported: true });
    expect(seeing.unsupported).toBe(0);
    expect(
      seeing.messages.filter((m) => m.role === "user" && m.images?.length),
    ).toHaveLength(1);
    const rest = textOf(seeing.messages.at(-1));
    expect(rest).toContain("[User attachments: 1 picture not sent to you]");
    expect(rest).toContain("b.png");
    expect(rest).toContain(`1 because ${STOPPED}`);
    expect(seeing.outcomes).toEqual([
      { index: 1, path: path("a.png"), outcome: "sent" },
      { index: 2, path: path("b.png"), outcome: "stopped" },
    ]);
  });

  it("tells the round, row by row, what went and why the others did not", async () => {
    // c.png has no stored copy.
    const root = workspace(["a.png"]);
    const record: TerminalRecord = [
      { kind: "user", text: "看图" },
      row("a.png"),
      row("b.png", { stopped: true }),
      row("c.png"),
      row("d.png", { removed: true }),
      noteRow,
    ];
    const plan = await planImages({
      record,
      freshFrom: record.length,
      supported: true,
      root,
    });
    expect(pictureOutcomes(record, plan)).toEqual([
      { index: 1, path: path("a.png"), outcome: "sent" },
      { index: 2, path: path("b.png"), outcome: "stopped" },
      { index: 3, path: path("c.png"), outcome: "unreadable" },
    ]);
  });
});

describe("pictures the user turned off (F04): an answered question's continuation", () => {
  it("does not read again a journalled picture turned off since, and says why", async () => {
    // a.png has no stored copy any more: read, it would be `unreadable`.
    const root = workspace(["b.png"]);
    const attached = (name: string): JournalMessage => ({
      role: "user",
      text: `[User attachment: picture]\n附件 ${name}\nThe picture itself is attached to this message.`,
      imageRefs: [path(name)],
    });
    const record: TerminalRecord = [
      { kind: "user", text: "看图" },
      row("a.png", { stopped: true }),
      row("b.png"),
    ];
    const stopped = stoppedPaths(record);
    expect([...stopped]).toEqual([path("a.png")]);
    const refs = new Map();
    const [a, b] = await fromJournal([attached("a.png"), attached("b.png")], {
      supported: true,
      root,
      refs,
      stopped,
    });
    expect(a?.role === "user" ? a.images : "x").toBeUndefined();
    expect(textOf(a)).toContain(
      `The picture was not sent to you (${STOPPED}).`,
    );
    expect(textOf(a)).not.toContain("The picture itself is attached");
    expect(b?.role === "user" ? b.images?.length : 0).toBe(1);
    expect(refs.size).toBe(1);
  });

  it("reads only this session's own copies for the persona (F02 design 2.8, R120)", async () => {
    const root = workspace(["a.png"]);
    mkdirSync(join(root, ".herta", "attachments", "s2"), { recursive: true });
    writeFileSync(join(root, ".herta", "attachments", "s2", "a.png"), PNG);
    const attached = (ref: string): JournalMessage => ({
      role: "user",
      text: `[User attachment: picture]\n附件 a.png\nThe picture itself is attached to this message.`,
      imageRefs: [ref],
    });
    const refs = new Map();
    const [own, other] = await fromJournal(
      [attached(path("a.png")), attached(".herta/attachments/s2/a.png")],
      { supported: true, root, refs, sessionId: "s1" },
    );
    expect(own?.role === "user" ? own.images?.length : 0).toBe(1);
    expect(other?.role === "user" ? other.images : "x").toBeUndefined();
    expect(textOf(other)).toContain(
      "The picture was not sent to you (its stored copy is missing",
    );
    expect(refs.size).toBe(1);
  });
});

describe("pictures the user turned off (F04): the round's evidence", () => {
  it("keeps each request's outcomes, the newest 64 rows, across a reload; none when no picture is cited", () => {
    const root = mkdtempSync(join(tmpdir(), "herta-f04-rounds-"));
    roots.push(root);
    const file = join(root, ".herta", "rounds", "s1.json");
    const store = new RoundStore(file, "s1", () => root);
    const outcomes: RoundPicture[] = Array.from({ length: 70 }, (_, i) => ({
      index: i + 1,
      path: path(`p${i}.png`),
      outcome: i % 2 ? "sent" : "over_limit",
    }));
    store.begin("t1", 0);
    store.pictures("persona", outcomes);
    store.pictures("executor", outcomes.slice(-2));
    store.finish("completed");
    store.begin("t2", 80);
    store.pictures("persona", []);
    store.finish("completed");
    const [first, second] = new RoundStore(file, "s1", () => root).summaries();
    expect(first?.pictures?.persona).toEqual(outcomes.slice(-64));
    expect(first?.pictures?.executor).toEqual(outcomes.slice(-2));
    expect(second?.pictures).toBeUndefined();
  });
});

describe("pictures the user turned off (F04): the session's command", () => {
  it("does not partly toggle or refresh a batch when persistence fails", () => {
    const record: TerminalRecordBlock[] = [row("a.png"), row("b.png")];
    const before = structuredClone(record);
    let writes = 0,
      refreshed = 0;
    const store = new SessionAttachments({
      sessionId: "s1",
      lang: "zh",
      wsHolder: { current: workspace([]) },
      captionImage: null,
      turnInFlight: () => false,
      driver: {
        getRecord: () => record,
        appendSystemBlock() {},
        replaceBlockAt: (index: number, block: TerminalRecordBlock) => {
          if (++writes === 2) throw new Error("disk full");
          record[index] = block;
          return true;
        },
        replaceBlocksAt: () => {
          writes++;
          throw new Error("disk full");
        },
      } as never,
      onAppended() {},
      onReplaced() {
        refreshed++;
      },
    });
    expect(() =>
      store.setPictureModelUse([target(record, 0), target(record, 1)], "stop"),
    ).toThrow("disk full");
    expect(record).toEqual(before);
    expect(writes).toBe(1);
    expect(refreshed).toBe(0);
  });

  function attachments(
    record: TerminalRecordBlock[],
    inTurn: () => boolean = () => false,
  ) {
    const calls = { replaced: [] as number[], refreshed: 0 };
    const store = new SessionAttachments({
      sessionId: "s1",
      lang: "zh",
      wsHolder: { current: workspace([]) },
      captionImage: null,
      turnInFlight: inTurn,
      driver: {
        getRecord: () => record as TerminalRecord,
        appendSystemBlock: (b: TerminalRecordBlock) => {
          record.push(b);
        },
        replaceBlockAt: (i: number, b: TerminalRecordBlock) => {
          calls.replaced.push(i);
          record[i] = b;
          return true;
        },
        replaceBlocksAt: (
          changes: readonly { index: number; block: TerminalRecordBlock }[],
        ) => {
          for (const { index, block } of changes) {
            calls.replaced.push(index);
            record[index] = block;
          }
          return true;
        },
      } as never,
      onAppended: () => {},
      onReplaced: () => {
        calls.refreshed++;
      },
    });
    return { store, calls };
  }
  const digestOf = (b: TerminalRecordBlock | undefined) =>
    b?.kind === "system" && b.digest?.kind === "attachment"
      ? b.digest
      : undefined;
  const target = (record: TerminalRecord, index: number) => ({
    index,
    path: digestOf(record[index])?.path ?? "",
  });

  it("turns a picture off and on again — every row citing the same copy — and rewrites only what changes", async () => {
    const record: TerminalRecordBlock[] = [
      { kind: "user", text: "看图" },
      { ...row("a.png"), at: "2026-10-29T01:00:00.000Z" },
      noteRow,
      row("a.png"), // the same bytes attached again: the same stored copy
      row("b.png"),
    ];
    const { store, calls } = attachments(record);
    expect(await store.setPictureModelUse([target(record, 1)], "stop")).toEqual(
      { ok: true, changed: 2 },
    );
    expect(calls.replaced).toEqual([1, 3]);
    expect(calls.refreshed).toBe(1);
    expect(digestOf(record[3])?.modelUse).toBe("stopped");
    expect(digestOf(record[4])?.modelUse).toBeUndefined();
    // Only the choice changed: the row reads, is dated and points where it did.
    expect(record[1]).toMatchObject({
      body: row("a.png").body,
      at: "2026-10-29T01:00:00.000Z",
    });
    expect(digestOf(record[1])).toEqual({
      ...digestOf(row("a.png")),
      modelUse: "stopped",
    });
    // Already so: nothing is rewritten and the renderer is not refreshed.
    expect(await store.setPictureModelUse([target(record, 3)], "stop")).toEqual(
      { ok: true, changed: 0 },
    );
    expect(calls.replaced).toEqual([1, 3]);
    expect(calls.refreshed).toBe(1);
    // On again: the field goes, as on a row that never had it.
    expect(await store.setPictureModelUse([target(record, 1)], "send")).toEqual(
      { ok: true, changed: 2 },
    );
    expect(digestOf(record[1])).toEqual(digestOf(row("a.png")));
    expect(Object.hasOwn(digestOf(record[3]) ?? {}, "modelUse")).toBe(false);
    expect(calls.refreshed).toBe(2);
  });

  it("refuses with nothing changed: during a turn, a row that moved or is not a stored picture, and malformed requests", async () => {
    const record: TerminalRecordBlock[] = [
      { kind: "user", text: "看图" },
      row("a.png"),
      noteRow,
      row("gone.png", { removed: true }),
    ];
    let inTurn = true;
    const { store, calls } = attachments(record, () => inTurn);
    const a = target(record, 1);
    expect(await store.setPictureModelUse([a], "stop")).toEqual({
      ok: false,
      reason: "turn_in_progress",
    });
    inTurn = false;
    for (const targets of [
      [{ index: 1, path: path("b.png") }], // another picture there now (a rewind since)
      [{ index: 2, path: path("notes.md") }], // a document
      [{ index: 3, path: path("gone.png") }], // taken back: no stored copy
      [{ index: 0, path: path("a.png") }], // the user's message
      [{ index: 9, path: path("a.png") }], // past the end
      [a, { index: 2, path: path("notes.md") }], // one bad target spoils the batch
    ])
      expect(await store.setPictureModelUse(targets, "stop")).toEqual({
        ok: false,
        reason: "not_found",
      });
    for (const [targets, use] of [
      [[], "stop"],
      [Array.from({ length: 33 }, () => a), "stop"],
      [[{ index: 1.5, path: a.path }], "stop"],
      [[{ index: -1, path: a.path }], "stop"],
      [[{ index: 1, path: "" }], "stop"],
      [[{ index: 1, path: 7 }], "stop"],
      [[null], "stop"],
      ["a.png", "stop"],
      [[a], "hide"],
    ] as const)
      expect(
        await store.setPictureModelUse(targets as never, use as never),
      ).toEqual({ ok: false, reason: "invalid" });
    expect(calls.replaced).toEqual([]);
    expect(calls.refreshed).toBe(0);
    expect(Object.hasOwn(digestOf(record[1]) ?? {}, "modelUse")).toBe(false);
  });
});
