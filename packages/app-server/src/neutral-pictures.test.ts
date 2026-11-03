import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRequest, ProviderConfig } from "@herta/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImagePreparer } from "./neutral-images.js";
import {
  docxParagraphs,
  makeDocx,
  makePdf,
} from "./testing/document-fixtures.js";
import { createSessionHost } from "./session-host.js";
import { removeTmpDir } from "./testing/tmp-workspace.js";
import type { AppServerConfig, SessionHost } from "./types.js";

/** What one request carried, kept without any picture's encoding. */
interface Seen {
  readonly modelId: string;
  readonly answered: boolean;
  readonly users: {
    readonly text: string;
    readonly images: { readonly mimeType: string; readonly sha256: string }[];
  }[];
}
const script = vi.hoisted(() => ({
  seen: [] as Seen[],
  mode: "reply" as "reply" | "ask",
}));
vi.mock("@herta/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@herta/providers")>();
  const { createHash } = await import("node:crypto");
  return {
    ...actual,
    createProtocolAdapter: (config: ProviderConfig) => ({
      protocol: config.protocol,
      async *stream(request: ModelRequest) {
        const nativeContext = {
          providerId: config.id,
          providerRevision: config.revision,
          protocol: config.protocol,
          modelId: request.modelId,
          opaque: { private: "r77" },
        };
        const answered = request.messages.some((m) => m.role === "tool");
        script.seen.push({
          modelId: request.modelId,
          answered,
          users: request.messages.flatMap((m) =>
            m.role === "user"
              ? [
                  {
                    text: m.text,
                    images: (m.images ?? []).map((i) => ({
                      mimeType: i.mimeType,
                      sha256: createHash("sha256")
                        .update(Buffer.from(i.data, "base64"))
                        .digest("hex"),
                    })),
                  },
                ]
              : [],
          ),
        });
        if (script.mode === "ask" && !answered) {
          yield {
            type: "tool-call-ready",
            call: {
              id: "input-1",
              tool: "request_user_input",
              input: {
                questions: [
                  {
                    id: "q",
                    prompt: "哪一处？",
                    kind: "text",
                    required: true,
                    allowText: true,
                    options: [],
                  },
                ],
              },
            },
          };
          yield { type: "finished", reason: "tool-calls", nativeContext };
          return;
        }
        yield { type: "text-delta", text: "Seen." };
        yield { type: "finished", reason: "stop", nativeContext };
      },
    }),
  };
});

/** A 1×1 PNG: real bytes the record stores and the request must carry unchanged. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const roots: string[] = [];
const hosts: SessionHost[] = [];
beforeEach(() => {
  script.seen = [];
  script.mode = "reply";
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.closeActiveSession();
  for (const root of roots.splice(0)) await removeTmpDir(root);
});

function provider(id: string, images: "supported" | "unknown"): ProviderConfig {
  return {
    id,
    name: id,
    protocol: "openai-chat-completions",
    // Not a documented vision endpoint: only the image probe's result can admit pictures.
    baseURL: "https://example.invalid/v1",
    authentication: "none",
    credentialRef: null,
    allowRemoteHTTP: false,
    revision: 1,
    models: [
      {
        id: `${id}-model`,
        source: "manual",
        capabilities: {
          streaming: "supported",
          tools: "supported",
          images,
          reasoning: "unknown",
        },
        validation: {
          state: "tools-available",
          protocol: "openai-chat-completions",
          providerRevision: 1,
        },
      },
    ],
    defaults: { model: `${id}-model`, timeoutMs: 1000 },
  };
}
function fixture(images: "supported" | "unknown", prepareImage?: ImagePreparer) {
  const root = mkdtempSync(join(tmpdir(), "herta-r77-pictures-"));
  roots.push(root);
  const persona = provider("persona", images);
  const executor = provider("executor", "unknown");
  const config: AppServerConfig = {
    workspaceRoot: root,
    transcriptDir: join(root, ".herta", "transcript", "v2"),
    projectMemoryDir: join(root, ".herta", "memory"),
    userMemoryDir: join(root, ".herta", "user-memory"),
    narrativeDir: join(root, ".herta", "narrative"),
    providers: {
      deepseekApiKey: "",
      actorModel: "unused",
      backendModel: "unused",
      routerModel: "unused",
    },
    neutralProviders: {
      resolveTurn: async (sessionId, turnId) => ({
        snapshot: {
          sessionId,
          turnId,
          persona,
          executor,
          bindings: {
            persona: { providerId: persona.id, modelId: "persona-model" },
            executor: { providerId: executor.id, modelId: "executor-model" },
          },
        },
        personaKey: null,
        executorKey: null,
      }),
      ...(prepareImage ? { prepareImage } : {}),
    },
  };
  const host = createSessionHost(config);
  hosts.push(host);
  return { root, host, config };
}
/** A file the user picks, outside the workspace (the attach copies it in). */
function picked(name: string, bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "herta-r77-picked-"));
  roots.push(dir);
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}
const persona = () => script.seen.filter((s) => s.modelId === "persona-model");
const pictures = (seen: Seen) => seen.users.filter((u) => u.images.length);
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

describe("workbench pictures reach the persona model as pictures (R77)", () => {
  it("sends a picture added with 添加文件 as an image block of the message, not only its row", async () => {
    const { root, host } = fixture("supported");
    const session = await host.createSession({ backendWorkspace: root });
    expect((await session.attachFiles!([picked("screen.png", PNG)])).ok).toBe(true);
    await session.submitText("看到了什么？");
    const [request] = persona();
    expect(persona()).toHaveLength(1);
    expect(pictures(request!)).toHaveLength(1);
    expect(pictures(request!)[0]!.images).toEqual([
      { mimeType: "image/png", sha256: sha(PNG) },
    ]);
    expect(pictures(request!)[0]!.text).toContain("[User attachment: picture]");
    expect(pictures(request!)[0]!.text).toContain("screen.png");
    // The row says what was attached; it no longer claims the picture went unread.
    const row = session.record.find(
      (b) => b.kind === "system" && b.digest?.kind === "attachment",
    );
    expect(
      row?.kind === "system" && row.digest?.kind === "attachment"
        ? row.digest.unreadable
        : "no row",
    ).toBeUndefined();
    expect(row?.kind === "system" ? row.body : "").not.toContain("未能读图");
  });

  it("sends staged pictures with the message they were staged for", async () => {
    const { root, host } = fixture("supported");
    const session = await host.createSession({ backendWorkspace: root });
    const staged = await session.stageImages!([{ path: picked("paste.png", PNG) }]);
    expect(staged.ok).toBe(true);
    await session.submitText("这张呢？", {
      stagedImageIds: staged.ok ? staged.staged.map((s) => s.id) : [],
    });
    expect(pictures(persona()[0]!).map((u) => u.images)).toEqual([
      [{ mimeType: "image/png", sha256: sha(PNG) }],
    ]);
  });

  it("shows earlier pictures again on the next message", async () => {
    const { root, host } = fixture("supported");
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png", PNG)]);
    await session.submitText("看到了什么？");
    await session.submitText("左上角写了什么？");
    expect(persona()).toHaveLength(2);
    expect(pictures(persona()[1]!)).toHaveLength(1);
  });

  it("stops before any request when the model is not verified for images, and does not loop", async () => {
    const { root, host } = fixture("unknown");
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png", PNG)]);
    await expect(session.submitText("看到了什么？")).rejects.toMatchObject({
      code: "image-unsupported",
    });
    expect(script.seen).toHaveLength(0);
    // Sending again goes ahead; the model is told the picture was not sent to it.
    await session.submitText("那先不看图了");
    expect(pictures(persona()[0]!)).toHaveLength(0);
    expect(
      persona()[0]!.users.some(
        (u) =>
          u.text.includes("picture, not sent") &&
          u.text.includes("not verified for image input"),
      ),
    ).toBe(true);
  });

  it("stops with image-unreadable when the stored copy of the message's picture is gone", async () => {
    const { root, host } = fixture("supported");
    const session = await host.createSession({ backendWorkspace: root });
    const attached = await session.attachFiles!([picked("screen.png", PNG)]);
    expect(attached.ok).toBe(true);
    rmSync(join(root, ...(attached.ok ? attached.files[0]!.path : "").split("/")));
    await expect(session.submitText("看到了什么？")).rejects.toMatchObject({
      code: "image-unreadable",
    });
    expect(script.seen).toHaveLength(0);
  });

  it("rescales a picture over the 2 MB request limit through the desktop's preparer", async () => {
    const big = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(2 * 1024 * 1024 + 64),
    ]);
    const prepared = vi.fn<ImagePreparer>(async () => ({
      mimeType: "image/png",
      data: PNG.toString("base64"),
    }));
    const { root, host } = fixture("supported", prepared);
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("photo.jpg", big)]);
    await session.submitText("看到了什么？");
    expect(prepared).toHaveBeenCalledOnce();
    expect(pictures(persona()[0]!)[0]!.images).toEqual([
      { mimeType: "image/png", sha256: sha(PNG) },
    ]);
  });

  it("puts attached text, PDF and DOCX content in front of the persona, not only their names", async () => {
    const { root, host } = fixture("supported");
    const session = await host.createSession({ backendWorkspace: root });
    const attached = await session.attachFiles!([
      picked("notes.md", Buffer.from("# R77 正文 7f3a\n")),
      picked("report.pdf", makePdf([["R77 PDF 41c2"]])),
      picked("中文.docx", makeDocx(docxParagraphs(["R77 DOCX 9b1e"]))),
    ]);
    expect(attached.ok).toBe(true);
    await session.submitText("总结这三个文件");
    const text = persona()[0]!.users.map((u) => u.text).join("\n");
    for (const content of ["R77 正文 7f3a", "R77 PDF 41c2", "R77 DOCX 9b1e"])
      expect(text).toContain(content);
  });

  it("journals a waiting question with the picture's path, not its bytes, and shows it again on the answer", async () => {
    script.mode = "ask";
    const { root, host } = fixture("supported");
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png", PNG)]);
    await session.submitText("看到了什么？");
    const pending = session.getPendingUserInput?.();
    expect(pending).not.toBeNull();
    const journal = files(root).filter((f) => f.endsWith(".user-input.json"));
    expect(journal).toHaveLength(1);
    const saved = readFileSync(journal[0]!, "utf8");
    expect(saved).not.toContain(PNG.toString("base64"));
    expect(saved).toContain("imageRefs");
    await session.answerUserInput?.({
      schemaVersion: 1,
      requestId: pending!.requestId,
      sessionId: pending!.sessionId,
      turnId: pending!.turnId,
      action: "answer",
      answers: [{ questionId: "q", optionIds: [], text: "左上角" }],
    });
    // The answer resumes the turn in the background, as in neutral-session.test.ts.
    const deadline = Date.now() + 10000;
    while (session.turnInFlight || !persona().some((s) => s.answered)) {
      if (Date.now() > deadline) throw new Error("answer turn did not run");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const answer = persona().find((s) => s.answered);
    expect(answer).toBeDefined();
    expect(pictures(answer!).map((u) => u.images)).toEqual([
      [{ mimeType: "image/png", sha256: sha(PNG) }],
    ]);
  });
});


it("R96 restores pending pictures in a new host, sends once and excludes committed copies", async () => {
  const { root, host, config } = fixture("supported");
  const first = await host.createSession({ backendWorkspace: root });
  const staged = await first.stageImages!([{ path: picked("recover.png", PNG) }]);
  if (!staged.ok) throw new Error("stage failed");
  const images = staged.staged;
  const id = first.sessionId;
  await host.closeActiveSession();
  const nextHost = createSessionHost(config); hosts.push(nextHost);
  const next = await nextHost.openSession({ sessionId: id });
  expect(next.stagedImageList).toEqual(images);
  expect(persona()).toHaveLength(0);
  await next.submitText("explicit image send", { stagedImageIds: images.map(image => image.id) });
  expect(pictures(persona()[0]!)[0]!.images[0]!.sha256).toBe(sha(PNG));
  await nextHost.closeActiveSession();
  const thirdHost = createSessionHost(config); hosts.push(thirdHost);
  const third = await thirdHost.openSession({ sessionId: id });
  expect(third.stagedImageList).toEqual([]);
  expect(persona()).toHaveLength(1);
  expect(readFileSync(join(root, images[0]!.path))).toEqual(PNG);
});
it("F02 design 2.8 (R120): shows the persona only this session's own copies, not a row naming another session's", async () => {
  const { root, host, config } = fixture("supported");
  const other = await host.createSession({ backendWorkspace: root });
  const theirs = await other.attachFiles!([picked("screen.png", PNG)]);
  if (!theirs.ok) throw new Error("attach failed");
  await host.closeActiveSession();
  const session = await host.createSession({ backendWorkspace: root });
  const ours = await session.attachFiles!([picked("screen.png", PNG)]);
  if (!ours.ok) throw new Error("attach failed");
  await session.submitText("看到了什么？");
  expect(pictures(persona()[0]!)).toHaveLength(1);
  const id = session.sessionId;
  await host.closeActiveSession();
  // The transcript now names the other session's copy, which is on disk and readable.
  const transcript = join(config.transcriptDir, `${id}.jsonl`);
  const ourPath = ours.files[0]!.path;
  const theirPath = theirs.files[0]!.path;
  expect(theirPath).not.toBe(ourPath);
  expect(existsSync(join(root, ...theirPath.split("/")))).toBe(true);
  writeFileSync(
    transcript,
    readFileSync(transcript, "utf8").split(ourPath).join(theirPath),
  );
  const nextHost = createSessionHost(config);
  hosts.push(nextHost);
  const next = await nextHost.openSession({ sessionId: id });
  await next.submitText("左上角写了什么？");
  const request = persona()[1]!;
  expect(pictures(request)).toHaveLength(0);
  expect(
    request.users.some(
      (u) => u.text.includes(theirPath) && u.text.includes("picture, not sent"),
    ),
  ).toBe(true);
});
it("R96 allows a session with a corrupt pending manifest to open without overwriting it", async () => {
  const { root, host, config } = fixture("supported");
  const first = await host.createSession({ backendWorkspace: root });
  await first.stageImages!([{ path: picked("recover.png", PNG) }]);
  const id = first.sessionId;
  await host.closeActiveSession();
  const path = join(config.transcriptDir, "pending-images", `${id}.json`);
  writeFileSync(path, "corrupt-original");
  const nextHost = createSessionHost(config); hosts.push(nextHost);
  const next = await nextHost.openSession({ sessionId: id });
  expect(next.stagedImageError).toContain("清单无法读取");
  expect(persona()).toHaveLength(0);
  await nextHost.closeActiveSession();
  expect(readFileSync(path, "utf8")).toBe("corrupt-original");
});

it("R96 keeps a missing restored image pending and makes no model request", async () => {
  const { root, host, config } = fixture("supported");
  const first = await host.createSession({ backendWorkspace: root });
  const staged = await first.stageImages!([{ path: picked("missing.png", PNG) }]);
  if (!staged.ok) throw new Error("stage failed");
  const image = staged.staged[0]!;
  const id = first.sessionId;
  await host.closeActiveSession();
  rmSync(join(root, image.path));
  const nextHost = createSessionHost(config); hosts.push(nextHost);
  const next = await nextHost.openSession({ sessionId: id });
  await expect(next.submitText("do not send without image", { stagedImageIds: [image.id] })).rejects.toMatchObject({ code: "image-unreadable" });
  expect(persona()).toHaveLength(0);
  expect(next.stagedImageList).toEqual([image]);
  expect(await next.unstageImage!(image.id)).toBe(true);
  await nextHost.closeActiveSession();
  const finalHost = createSessionHost(config); hosts.push(finalHost);
  expect((await finalHost.openSession({ sessionId: id })).stagedImageList).toEqual([]);
});

it("R96 rewinding a sent image restores only one pending reference across close", async () => {
  const { root, host, config } = fixture("supported");
  const session = await host.createSession({ backendWorkspace: root });
  const staged = await session.stageImages!([{ path: picked("rewind.png", PNG) }]);
  if (!staged.ok) throw new Error("stage failed");
  await session.submitText("first", { stagedImageIds: staged.staged.map(i => i.id) });
  expect((await session.rewindLastTurn!()).ok).toBe(true);
  expect(session.stagedImageList).toHaveLength(1);
  const pending = session.stagedImageList;
  await host.closeActiveSession();
  const next = createSessionHost(config); hosts.push(next);
  expect((await next.openSession({ sessionId: session.sessionId })).stagedImageList).toEqual(pending);
});

it("R98 resets an unreadable manifest on request, keeps its bytes, and stages again across close", async () => {
  const { root, host, config } = fixture("supported");
  const first = await host.createSession({ backendWorkspace: root });
  const before = await first.stageImages!([{ path: picked("before.png", PNG) }]);
  if (!before.ok) throw new Error("stage failed");
  const id = first.sessionId;
  await host.closeActiveSession();
  const path = join(config.transcriptDir, "pending-images", `${id}.json`);
  writeFileSync(path, "corrupt-original");
  const nextHost = createSessionHost(config); hosts.push(nextHost);
  const next = await nextHost.openSession({ sessionId: id });
  const refused = await next.stageImages!([{ path: picked("refused.png", PNG) }]);
  expect(refused).toMatchObject({ ok: true, staged: [], rejected: [{ reason: "manifest_unreadable" }] });
  const reset = await next.resetPendingImages!();
  if (!reset.ok) throw new Error("reset failed");
  expect(readFileSync(join(config.transcriptDir, "pending-images", reset.backup), "utf8")).toBe("corrupt-original");
  expect(next.stagedImageError).toBeNull();
  expect(readFileSync(join(root, before.staged[0]!.path))).toEqual(PNG);
  const after = await next.stageImages!([{ path: picked("after.png", PNG) }]);
  if (!after.ok || after.staged.length !== 1) throw new Error("stage after reset failed");
  expect(persona()).toHaveLength(0);
  await nextHost.closeActiveSession();
  const thirdHost = createSessionHost(config); hosts.push(thirdHost);
  const third = await thirdHost.openSession({ sessionId: id });
  expect(third.stagedImageError).toBeNull();
  expect(third.stagedImageList).toEqual(after.staged);
});

it("R98 leaves a readable manifest alone when asked to reset", async () => {
  const { root, host, config } = fixture("supported");
  const session = await host.createSession({ backendWorkspace: root });
  const staged = await session.stageImages!([{ path: picked("keep.png", PNG) }]);
  if (!staged.ok) throw new Error("stage failed");
  const path = join(config.transcriptDir, "pending-images", `${session.sessionId}.json`);
  const original = readFileSync(path, "utf8");
  expect(await session.resetPendingImages!()).toEqual({ ok: false, reason: "nothing_to_reset" });
  expect(readFileSync(path, "utf8")).toBe(original);
  expect(session.stagedImageList).toEqual(staged.staged);
});

it("R98 reads restored pictures at send without touching the record or the model", async () => {
  const { root, host, config } = fixture("supported");
  const first = await host.createSession({ backendWorkspace: root });
  const kept = await first.stageImages!([{ path: picked("kept.png", PNG) }]);
  const lost = await first.stageImages!([{ path: picked("lost.png", PNG) }]);
  if (!kept.ok || !lost.ok) throw new Error("stage failed");
  const id = first.sessionId;
  await host.closeActiveSession();
  rmSync(join(root, lost.staged[0]!.path));
  const nextHost = createSessionHost(config); hosts.push(nextHost);
  const next = await nextHost.openSession({ sessionId: id });
  const record = next.record.length;
  expect(await next.prepareStagedImages!([kept.staged[0]!.id, lost.staged[0]!.id])).toEqual([lost.staged[0]!.id]);
  expect(next.record.length).toBe(record);
  expect(persona()).toHaveLength(0);
  expect(next.stagedImageList).toHaveLength(2);
  expect(await next.unstageImage!(lost.staged[0]!.id)).toBe(true);
  await next.submitText("only the kept picture", { stagedImageIds: [kept.staged[0]!.id] });
  expect(pictures(persona()[0]!).flatMap((u) => u.images)).toEqual([{ mimeType: "image/png", sha256: sha(PNG) }]);
});

describe("R100 attachments across a workspace change and storage failures", () => {
  it("pending pictures follow a workspace change and come back from the new root after a restart", async () => {
    const { root, host, config } = fixture("supported");
    const session = await host.createSession({ backendWorkspace: root });
    const staged = await session.stageImages!([{ path: picked("moving.png", PNG) }]);
    if (!staged.ok || staged.staged.length !== 1) throw new Error("stage failed");
    const image = staged.staged[0]!;
    const next = mkdtempSync(join(tmpdir(), "herta-r100-next-"));
    roots.push(next);
    expect(await session.setWorkspace!(next)).toEqual({ ok: true });
    expect(existsSync(join(root, image.path))).toBe(false);
    expect(readFileSync(join(next, image.path))).toEqual(PNG);
    const id = session.sessionId;
    await host.closeActiveSession();
    const nextHost = createSessionHost(config); hosts.push(nextHost);
    const reopened = await nextHost.openSession({ sessionId: id });
    expect(reopened.stagedImageList).toEqual([image]);
    expect(persona()).toHaveLength(0);
    await reopened.submitText("after the move", { stagedImageIds: [image.id] });
    expect(pictures(persona()[0]!).flatMap((u) => u.images)).toEqual([{ mimeType: "image/png", sha256: sha(PNG) }]);
  });

  it("refuses a workspace change while a copy is written, and copies while the directory moves", async () => {
    const { root, host } = fixture("supported");
    const session = await host.createSession({ backendWorkspace: root });
    const next = mkdtempSync(join(tmpdir(), "herta-r100-race-"));
    roots.push(next);
    const staging = session.stageImages!([{ path: picked("racing.png", PNG) }]);
    expect(await session.setWorkspace!(next)).toEqual({ ok: false, reason: "attachments_in_progress" });
    const staged = await staging;
    if (!staged.ok || staged.staged.length !== 1) throw new Error("stage failed");
    const moving = session.setWorkspace!(next);
    expect(await session.stageImages!([{ path: picked("late.png", PNG) }])).toEqual({ ok: false, reason: "workspace_changing" });
    expect(await session.attachFiles!([picked("late.md", Buffer.from("# late\n"))])).toEqual({ ok: false, reason: "workspace_changing" });
    expect(await moving).toEqual({ ok: true });
    // Both the earlier copy and a new one now live under the new root only.
    expect(readFileSync(join(next, staged.staged[0]!.path))).toEqual(PNG);
    const after = await session.stageImages!([{ path: picked("after.png", PNG) }]);
    if (!after.ok || after.staged.length !== 1) throw new Error("stage after move failed");
    expect(existsSync(join(next, after.staged[0]!.path))).toBe(true);
    expect(existsSync(join(root, after.staged[0]!.path))).toBe(false);
  });

  it("calls a copy that cannot be written not_saved, not a read failure", async () => {
    const { root, host } = fixture("supported");
    const session = await host.createSession({ backendWorkspace: root });
    const blocker = join(root, ".herta", "attachments", session.sessionId);
    mkdirSync(join(root, ".herta", "attachments"), { recursive: true });
    writeFileSync(blocker, "a file where the attachment folder should be");
    const refused = await session.stageImages!([{ path: picked("blocked.png", PNG) }]);
    expect(refused).toMatchObject({ ok: true, staged: [], rejected: [{ name: "blocked.png", reason: "not_saved" }] });
    expect(session.stagedImageList).toEqual([]);
    rmSync(blocker);
    const retried = await session.stageImages!([{ path: picked("blocked.png", PNG) }]);
    expect(retried).toMatchObject({ ok: true, rejected: [] });
  });

  it("sends nothing of a message whose queued document is gone, when asked for all of them", async () => {
    const { root, host } = fixture("supported");
    const session = await host.createSession({ backendWorkspace: root });
    const present = picked("present.md", Buffer.from("# here\n"));
    const goneDir = mkdtempSync(join(tmpdir(), "herta-r100-gone-"));
    roots.push(goneDir);
    const gone = join(goneDir, "gone.md");
    const before = session.record.length;
    expect(await session.attachFiles!([present, gone], undefined, { requireAll: true })).toEqual({ ok: false, reason: "missing", missing: [gone] });
    expect(session.record.length).toBe(before);
    // Without the option the old ingest stands: the gone file is an unreadable row.
    const legacy = await session.attachFiles!([present, gone]);
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(legacy.files.map((f) => f.unreadable ?? "read")).toEqual(["read", "read_error"]);
  });
});
