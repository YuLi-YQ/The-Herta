import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BackendPromptFrame,
  SystemBlock,
  TerminalRecord,
} from "@herta/core";
import { V2RecordPersister } from "@herta/core";
import {
  type ModelRequest,
  type NeutralMessage,
  type ProtocolAdapter,
  type ProviderConfig,
  ProviderError,
} from "@herta/providers";
import type { ImageRequestRefused } from "@herta/providers/images";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planExecutorPictures } from "./neutral-images.js";
import {
  type ExecutorPictureSet,
  NeutralBackendProvider,
} from "./neutral-provider.js";
import { createSessionHost } from "./session-host.js";
import { removeTmpDir } from "./testing/tmp-workspace.js";
import type { AppServerConfig, SessionHost } from "./types.js";

// F02 (R112): the executor model is handed the delegation's pictures itself, judged by its own
// image check. Deterministic adapters on a real host, record, journal and tools; not a service or
// packaged-app verification.

/** What one request carried, each picture by the sha-256 of its bytes. */
type Summary =
  | {
      readonly role: "user";
      readonly text: string;
      readonly images: readonly string[];
    }
  | { readonly role: "assistant"; readonly calls: readonly string[] }
  | { readonly role: "tool"; readonly summary: string };
interface Seen {
  readonly modelId: string;
  readonly system: string;
  readonly messages: readonly Summary[];
}
type Outcome =
  | { readonly kind: "reply" | "write" | "hang" }
  | { readonly kind: "http"; readonly status: number };
const script = vi.hoisted(() => ({
  seen: [] as Seen[],
  /** Taken one per executor request, in order; a plain reply once empty. */
  executor: [] as Outcome[],
  /** What the persona does when it may delegate: delegate, reply without delegating, or ask a
   *  question first and delegate after the answer. */
  persona: "delegate" as "delegate" | "reply" | "ask",
}));
vi.mock("@herta/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@herta/providers")>();
  const { createHash } = await import("node:crypto");
  const digest = (data: string) =>
    createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
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
          opaque: { private: "f02" },
        };
        script.seen.push({
          modelId: request.modelId,
          system: request.system,
          messages: request.messages.map(
            (m): Summary =>
              m.role === "user"
                ? {
                    role: "user",
                    text: m.text,
                    images: (m.images ?? []).map((i) => digest(i.data)),
                  }
                : m.role === "assistant"
                  ? { role: "assistant", calls: m.toolCalls.map((c) => c.tool) }
                  : { role: "tool", summary: String(m.result.summary ?? "") },
          ),
        });
        if (request.modelId === "persona-model") {
          if (
            script.persona === "ask" &&
            !request.messages.some((m) => m.role === "tool")
          ) {
            yield {
              type: "tool-call-ready",
              call: {
                id: "input-1",
                tool: "request_user_input",
                input: {
                  questions: [
                    {
                      id: "q",
                      prompt: "改哪一处？",
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
          if (
            script.persona !== "reply" &&
            request.tools.some((t) => t.name === "delegate_execution")
          ) {
            yield { type: "text-delta", text: "Delegating." };
            yield {
              type: "tool-call-ready",
              call: { id: "delegate-1", tool: "delegate_execution", input: {} },
            };
            yield { type: "finished", reason: "tool-calls", nativeContext };
            return;
          }
          yield { type: "text-delta", text: "Done." };
          yield { type: "finished", reason: "stop", nativeContext };
          return;
        }
        const outcome = script.executor.shift() ?? { kind: "reply" };
        if (outcome.kind === "http")
          throw new actual.ProviderError({
            code: "http",
            status: outcome.status,
            message: `Provider HTTP ${outcome.status}`,
            retryable: false,
          });
        if (outcome.kind === "hang") {
          await new Promise<void>((_resolve, reject) =>
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            ),
          );
          return;
        }
        if (outcome.kind === "write") {
          const n = script.seen.filter(
            (s) => s.modelId === "executor-model",
          ).length;
          yield {
            type: "tool-call-ready",
            call: {
              id: `write-${n}`,
              tool: "write_new_file",
              input: { path: `f02-${n}.txt`, content: "F02 executor write\n" },
            },
          };
          yield { type: "finished", reason: "tool-calls", nativeContext };
          return;
        }
        yield { type: "text-delta", text: "Execution finished." };
        yield { type: "finished", reason: "stop", nativeContext };
      },
    }),
  };
});

/** A 1×1 PNG; `picture(n)` is the same picture with one trailing byte, so each has its own hash. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);
const picture = (n: number) => Buffer.concat([PNG, Buffer.from([n])]);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const roots: string[] = [];
const hosts: SessionHost[] = [];
beforeEach(() => {
  script.seen = [];
  script.executor = [];
  script.persona = "delegate";
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
    revision: id === "executor" ? 4 : 1,
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
          providerRevision: id === "executor" ? 4 : 1,
        },
      },
    ],
    defaults: { model: `${id}-model`, timeoutMs: 1000 },
  };
}
function fixture(
  opts: {
    readonly persona?: "supported" | "unknown";
    readonly executor?: "supported" | "unknown";
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "herta-f02-executor-"));
  roots.push(root);
  const persona = provider("persona", opts.persona ?? "supported");
  const executor = provider("executor", opts.executor ?? "supported");
  const refused = vi.fn<(r: ImageRequestRefused) => void>();
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
      onImageRequestRefused: refused,
    },
  };
  const host = createSessionHost(config);
  hosts.push(host);
  return { root, host, refused };
}
/** A file the user picks, outside the workspace (the attach copies it in). */
function picked(name: string, bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "herta-f02-picked-"));
  roots.push(dir);
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Timed out awaiting session state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const executorRequests = () =>
  script.seen.filter((s) => s.modelId === "executor-model");
const personaRequests = () =>
  script.seen.filter((s) => s.modelId === "persona-model");
const images = (seen: Seen) =>
  seen.messages.flatMap((m) => (m.role === "user" ? m.images : []));
const userText = (seen: Seen) =>
  seen.messages.flatMap((m) => (m.role === "user" ? [m.text] : [])).join("\n");
const notes = (record: TerminalRecord, phrase: string) =>
  record.filter((b) => b.kind === "system" && b.body.includes(phrase));
const evidence = (seen: Seen) =>
  seen.messages
    .flatMap((m) => (m.role === "tool" ? [m.summary] : []))
    .join("\n");

const WITHHELD = "图片没有发给执行模型";
const REFUSED = "执行模型拒绝了这次附带图片的请求";
/** F02 design 2.8: the record's note, and what the persona reads, when only the executor model
 *  is verified for images. */
const NOT_SHOWN = "图片没有发给黑塔";
const HANDED_ON = "is handed this picture with a delegation";
const textOf = (m?: Summary) => (m?.role === "user" ? m.text : "");

describe("the executor model is handed the delegation's pictures (F02)", () => {
  it("hands the message's picture to an executor verified for images, right after its anchor, on every step", async () => {
    const { root, host } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.setWorkspaceTrust?.("workspace");
    expect((await session.attachFiles!([picked("screen.png", PNG)])).ok).toBe(
      true,
    );
    script.executor = [{ kind: "write" }];
    await session.submitText("按截图修改文件");
    const runs = executorRequests();
    // The tool call, then the reply after its result: both steps carry the picture.
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(images(run)).toEqual([sha(PNG)]);
      const [anchor, row] = run.messages;
      expect(anchor).toMatchObject({ role: "user", images: [] });
      expect(anchor?.role === "user" ? anchor.text : "").toContain(
        "Execute the current user task",
      );
      expect(row).toMatchObject({ role: "user", images: [sha(PNG)] });
      expect(row?.role === "user" ? row.text : "").toContain(
        "[User attachment: picture]",
      );
      expect(row?.role === "user" ? row.text : "").toContain("screen.png");
    }
    expect(runs[1]?.messages.some((m) => m.role === "tool")).toBe(true);
    expect(readFileSync(join(root, "f02-1.txt"), "utf8")).toBe(
      "F02 executor write\n",
    );
    // The persona is shown it as before (R77), and nothing was withheld to report.
    expect(images(personaRequests()[0]!)).toEqual([sha(PNG)]);
    expect(notes(session.record, WITHHELD)).toHaveLength(0);
  });

  it("tells an executor that is not verified for images the picture was not sent, and says so in the record", async () => {
    const { root, host } = fixture({ executor: "unknown" });
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png", PNG)]);
    await session.submitText("按截图修改文件");
    const [run] = executorRequests();
    expect(run).toBeDefined();
    expect(images(run!)).toEqual([]);
    const text = userText(run!);
    expect(text).toContain("[User attachments: 1 picture not sent to you]");
    expect(text).toContain("screen.png");
    expect(text).toContain(
      "the executor model is not verified for image input",
    );
    expect(text).toContain("do not guess what it shows");
    const [note] = notes(session.record, WITHHELD);
    expect(note?.kind === "system" ? note.body : "").toContain("1 张图片");
    // The persona reads it with the executor's evidence, so the reply can say so.
    expect(evidence(personaRequests().at(-1)!)).toContain(WITHHELD);
    // A plain delegation: the turn went on, one request per pass.
    expect(executorRequests()).toHaveLength(1);
    expect(personaRequests()).toHaveLength(2);
  });

  it("judges the executor by its own image check, never the persona's", async () => {
    const { root, host } = fixture({
      persona: "unknown",
      executor: "supported",
    });
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png", PNG)]);
    // F02 design 2.8 (the user's decision, 2026-10-29): the executor can read the picture, so the
    // message is not stopped as R77 stops it; the persona is not shown it.
    await session.submitText("按截图修改");
    expect(images(personaRequests()[0]!)).toEqual([]);
    expect(images(executorRequests()[0]!)).toEqual([sha(PNG)]);
    expect(notes(session.record, WITHHELD)).toHaveLength(0);
  });

  it("keeps handing earlier pictures to the executor on later delegations", async () => {
    const { root, host } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png", PNG)]);
    await session.submitText("按截图修改");
    await session.submitText("再改左上角那一处");
    const runs = executorRequests();
    expect(runs).toHaveLength(2);
    expect(images(runs[1]!)).toEqual([sha(PNG)]);
  });

  it("stays within the request ceilings: the message's pictures first, then the newest earlier ones", async () => {
    const { root, host } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    const first = await session.attachFiles!(
      [1, 2, 3, 4, 5].map((n) => picked(`p${n}.png`, picture(n))),
    );
    expect(first.ok).toBe(true);
    await session.submitText("第一批");
    expect(images(executorRequests()[0]!)).toEqual(
      [1, 2, 3, 4, 5].map((n) => sha(picture(n))),
    );
    const second = await session.attachFiles!(
      [6, 7, 8, 9].map((n) => picked(`p${n}.png`, picture(n))),
    );
    expect(second.ok).toBe(true);
    await session.submitText("第二批");
    const run = executorRequests()[1]!;
    expect(images(run)).toEqual(
      [2, 3, 4, 5, 6, 7, 8, 9].map((n) => sha(picture(n))),
    );
    const oldest = run.messages.find(
      (m) => m.role === "user" && m.text.includes("p1.png"),
    );
    expect(oldest).toMatchObject({ role: "user", images: [] });
    expect(oldest?.role === "user" ? oldest.text : "").toContain(
      "at most 8 pictures",
    );
    // Room, not capability: nothing for the record to report.
    expect(notes(session.record, WITHHELD)).toHaveLength(0);
  });

  it("a continued run gets the delegation's pictures again and repeats no completed write", async () => {
    const { root, host } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.setWorkspaceTrust?.("workspace");
    await session.attachFiles!([picked("screen.png", PNG)]);
    script.executor = [{ kind: "write" }, { kind: "hang" }];
    const running = session.submitText("按截图修改文件");
    const rejected = expect(running).rejects.toBeDefined();
    await until(() => executorRequests().length > 1);
    await session.interrupt();
    await rejected;
    await until(() => session.resumable === true);
    const written = join(root, "f02-1.txt");
    const bytes = readFileSync(written, "utf8");
    const mtime = statSync(written).mtimeMs;
    await host.closeActiveSession();
    const count = executorRequests().length;
    const reopened = await host.openSession({ sessionId: session.sessionId });
    await reopened.regenerateLastReplyIfOrphaned?.();
    expect(executorRequests()).toHaveLength(count);
    await reopened.continueInterrupted?.();
    const resumed = executorRequests().slice(count);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.messages[1]).toMatchObject({
      role: "user",
      images: [sha(PNG)],
    });
    expect(images(resumed[0]!)).toEqual([sha(PNG)]);
    // The journal's tool result rides along; the write itself is not done again.
    expect(resumed[0]!.messages.some((m) => m.role === "tool")).toBe(true);
    expect(readFileSync(written, "utf8")).toBe(bytes);
    expect(statSync(written).mtimeMs).toBe(mtime);
  });

  it("names the picture in the executor's task history as a picture, not a file to read (F02 design 2.8)", async () => {
    for (const executor of ["supported", "unknown"] as const) {
      script.seen = [];
      const { root, host } = fixture({ executor });
      const session = await host.createSession({ backendWorkspace: root });
      await session.attachFiles!([picked("screen.png", PNG)]);
      await session.submitText("按截图修改文件");
      const [run] = executorRequests();
      // The quoted user history is in the system prompt; the picture itself, or the note saying
      // it was not sent, follows the anchor.
      expect(run?.system).toContain("〔附件〕开拓者提供了图片：screen.png");
      expect(run?.system).toContain(
        "文件工具无法显示图片。若它发给了你，就附在本次对话开头的用户消息中",
      );
      expect(run?.system).not.toContain("用文件工具自行读取");
      expect(run?.system).toContain("按截图修改文件");
      expect(images(run!)).toEqual(executor === "supported" ? [sha(PNG)] : []);
    }
  });
});

describe("a persona model not verified for images, with an executor model that is (F02 design 2.8)", () => {
  // The user's decision (2026-10-29): such a message is not stopped as R77 stops it. The persona is
  // not shown its pictures and is told so; a delegation hands them to the executor.
  it("lets the message go: the persona is told the picture was not sent to her and that a delegation hands it over", async () => {
    const { root, host } = fixture({
      persona: "unknown",
      executor: "supported",
    });
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png", PNG)]);
    await session.submitText("按截图修改文件");
    const first = personaRequests()[0]!;
    expect(images(first)).toEqual([]);
    const text = userText(first);
    expect(text).toContain("[User attachment: picture, not sent]");
    expect(text).toContain("screen.png");
    expect(text).toContain("the current model is not verified for image input");
    expect(text).toContain(HANDED_ON);
    expect(text).toContain(
      "Do not guess what it shows; if asked, say you cannot see it.",
    );
    // The record says so once, and the persona reads that row with the rest of the record.
    const shown = notes(session.record, NOT_SHOWN);
    expect(shown).toHaveLength(1);
    const body = shown[0]?.kind === "system" ? shown[0].body : "";
    expect(body).toContain("本条消息的 1 张图片会随委派发给执行模型");
    expect(body).toContain("没有委派时，没有模型看到这些图片");
    expect(text).toContain(body);
    // The delegation hands the executor the message's picture right after its anchor; nothing
    // reports it withheld, and no persona request ever carried it.
    const runs = executorRequests();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.messages[1]).toMatchObject({
      role: "user",
      images: [sha(PNG)],
    });
    expect(images(runs[0]!)).toEqual([sha(PNG)]);
    expect(notes(session.record, WITHHELD)).toHaveLength(0);
    expect(personaRequests().flatMap(images)).toEqual([]);
  });

  it("a persona that answers without delegating: no model is shown the picture, and she is told not to guess", async () => {
    script.persona = "reply";
    const { root, host } = fixture({
      persona: "unknown",
      executor: "supported",
    });
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png", PNG)]);
    await session.submitText("这张截图里写了什么？");
    expect(executorRequests()).toHaveLength(0);
    expect(personaRequests()).toHaveLength(1);
    expect(script.seen.flatMap(images)).toEqual([]);
    const text = userText(personaRequests()[0]!);
    expect(text).toContain(HANDED_ON);
    expect(text).toContain("if asked, say you cannot see it");
    expect(notes(session.record, NOT_SHOWN)).toHaveLength(1);
    expect(notes(session.record, WITHHELD)).toHaveLength(0);
  });

  it("still stops before any request when neither model is verified for images (R77)", async () => {
    const { root, host } = fixture({ persona: "unknown", executor: "unknown" });
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png", PNG)]);
    await expect(session.submitText("按截图修改")).rejects.toMatchObject({
      code: "image-unsupported",
    });
    expect(script.seen).toHaveLength(0);
    expect(notes(session.record, NOT_SHOWN)).toHaveLength(0);
    // Sending again goes ahead without the picture for either model; neither is told otherwise.
    await session.submitText("那先不看图了");
    const text = userText(personaRequests()[0]!);
    expect(text).toContain("[User attachment: picture, not sent]");
    expect(text).not.toContain(HANDED_ON);
    expect(images(executorRequests()[0]!)).toEqual([]);
    expect(notes(session.record, WITHHELD)).toHaveLength(1);
    expect(notes(session.record, NOT_SHOWN)).toHaveLength(0);
  });

  it("still stops when the message's picture cannot reach the executor either: its copy is gone", async () => {
    const { root, host } = fixture({
      persona: "unknown",
      executor: "supported",
    });
    const session = await host.createSession({ backendWorkspace: root });
    const attached = await session.attachFiles!([picked("screen.png", PNG)]);
    expect(attached.ok).toBe(true);
    rmSync(
      join(root, ...(attached.ok ? attached.files[0]!.path : "").split("/")),
    );
    await expect(session.submitText("按截图修改")).rejects.toMatchObject({
      code: "image-unreadable",
    });
    expect(script.seen).toHaveLength(0);
    expect(notes(session.record, NOT_SHOWN)).toHaveLength(0);
  });

  it("still stops when the message carries more pictures than one request can", async () => {
    const { root, host } = fixture({
      persona: "unknown",
      executor: "supported",
    });
    const session = await host.createSession({ backendWorkspace: root });
    const attached = await session.attachFiles!(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => picked(`p${n}.png`, picture(n))),
    );
    expect(attached.ok).toBe(true);
    await expect(session.submitText("九张一起看")).rejects.toMatchObject({
      code: "image-over-limit",
    });
    expect(script.seen).toHaveLength(0);
    expect(notes(session.record, NOT_SHOWN)).toHaveLength(0);
  });

  it("tells the persona which earlier pictures a delegation hands over: the newest that fit one request", async () => {
    const { root, host } = fixture({
      persona: "unknown",
      executor: "supported",
    });
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!(
      [1, 2, 3, 4, 5].map((n) => picked(`p${n}.png`, picture(n))),
    );
    await session.submitText("第一批");
    await session.attachFiles!(
      [6, 7, 8, 9].map((n) => picked(`p${n}.png`, picture(n))),
    );
    await session.submitText("第二批");
    // The message's four, then the newest four earlier ones; the oldest does not fit.
    expect(images(executorRequests()[1]!)).toEqual(
      [2, 3, 4, 5, 6, 7, 8, 9].map((n) => sha(picture(n))),
    );
    const second = personaRequests().find((s) =>
      userText(s).includes("第二批"),
    )!;
    expect(images(second)).toEqual([]);
    const row = (name: string) =>
      textOf(
        second.messages.find((m) => m.role === "user" && m.text.includes(name)),
      );
    for (const n of [2, 3, 4, 5, 6, 7, 8, 9])
      expect(row(`p${n}.png`)).toContain(HANDED_ON);
    // The oldest goes to neither model, and the persona is not told it does.
    expect(row("p1.png")).toContain("not verified for image input");
    expect(row("p1.png")).not.toContain(HANDED_ON);
    expect(
      notes(session.record, NOT_SHOWN).map((b) =>
        b.kind === "system" ? b.body : "",
      ),
    ).toEqual([
      expect.stringContaining("本条消息的 5 张图片"),
      expect.stringContaining("本条消息的 4 张图片"),
    ]);
  });

  it("a waiting question keeps what the persona was told, and the delegation after the answer hands the picture over", async () => {
    script.persona = "ask";
    const { root, host } = fixture({
      persona: "unknown",
      executor: "supported",
    });
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png", PNG)]);
    await session.submitText("按截图修改");
    const pending = session.getPendingUserInput?.();
    expect(pending).not.toBeNull();
    expect(executorRequests()).toHaveLength(0);
    await session.answerUserInput?.({
      schemaVersion: 1,
      requestId: pending!.requestId,
      sessionId: pending!.sessionId,
      turnId: pending!.turnId,
      action: "answer",
      answers: [{ questionId: "q", optionIds: [], text: "左上角" }],
    });
    // The answer resumes the turn in the background: ask, delegate, close.
    await until(() => !session.turnInFlight && personaRequests().length === 3);
    const answered = personaRequests()[1]!;
    expect(images(answered)).toEqual([]);
    expect(userText(answered)).toContain(HANDED_ON);
    expect(userText(answered)).toContain(NOT_SHOWN);
    expect(executorRequests()).toHaveLength(1);
    expect(images(executorRequests()[0]!)).toEqual([sha(PNG)]);
    expect(notes(session.record, NOT_SHOWN)).toHaveLength(1);
  });
});

describe("a refused executor request that carried the delegation's pictures (F02 with R110)", () => {
  it.each([
    400, 415, 422,
  ])("HTTP %i: marks the executor model once, says so in the record, sends nothing again", async (status) => {
    const { root, host, refused } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png", PNG)]);
    script.executor = [{ kind: "http", status }];
    await session.submitText("按截图修改").catch(() => undefined);
    expect(refused.mock.calls).toEqual([
      [
        {
          providerId: "executor",
          providerRevision: 4,
          modelId: "executor-model",
          status,
          surface: "workbench",
        },
      ],
    ]);
    // A 4xx is not retried: one executor request, no tool ran.
    expect(executorRequests()).toHaveLength(1);
    const [note] = notes(session.record, REFUSED);
    expect(note?.kind === "system" ? note.body : "").toContain(
      `HTTP ${status}`,
    );
    expect(note?.kind === "system" ? note.body : "").toContain("原因未确认");
    expect(evidence(personaRequests().at(-1)!)).toContain(REFUSED);
  });

  it("HTTP 413: says the request was too large and marks nothing", async () => {
    const { root, host, refused } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png", PNG)]);
    script.executor = [{ kind: "http", status: 413 }];
    await session.submitText("按截图修改").catch(() => undefined);
    expect(refused).not.toHaveBeenCalled();
    expect(executorRequests()).toHaveLength(1);
    const [note] = notes(session.record, REFUSED);
    expect(note?.kind === "system" ? note.body : "").toContain(
      "请求过大（HTTP 413）",
    );
  });

  it("does not put a refusal on the pictures once a request carrying them went through", async () => {
    const { root, host, refused } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.setWorkspaceTrust?.("workspace");
    await session.attachFiles!([picked("screen.png", PNG)]);
    script.executor = [{ kind: "write" }, { kind: "http", status: 400 }];
    await session.submitText("按截图修改文件").catch(() => undefined);
    expect(executorRequests()).toHaveLength(2);
    expect(images(executorRequests()[1]!)).toEqual([sha(PNG)]);
    expect(refused).not.toHaveBeenCalled();
    expect(notes(session.record, REFUSED)).toHaveLength(0);
  });

  it("never marks anything for an executor refusal when the request carried no pictures", async () => {
    const { root, host, refused } = fixture({ executor: "unknown" });
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png", PNG)]);
    script.executor = [{ kind: "http", status: 400 }];
    await session.submitText("按截图修改").catch(() => undefined);
    expect(images(executorRequests()[0]!)).toEqual([]);
    expect(refused).not.toHaveBeenCalled();
    expect(notes(session.record, REFUSED)).toHaveLength(0);
  });
});

describe("which pictures a delegation may hand over (planExecutorPictures)", () => {
  function row(path: string, unreadable?: "removed"): SystemBlock {
    const name = path.split("/").at(-1) ?? "";
    return {
      kind: "system",
      label: "系统",
      body: `附件 ${name} · 图片 PNG · 1×1 · ${path}`,
      digest: {
        kind: "attachment",
        name,
        path,
        lines: 0,
        chars: 0,
        image: { format: "png", width: 1, height: 1 },
        ...(unreadable ? { unreadable } : {}),
      },
    };
  }
  function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), "herta-f02-plan-"));
    roots.push(root);
    for (const sid of ["s1", "s2"]) {
      mkdirSync(join(root, ".herta", "attachments", sid), { recursive: true });
      writeFileSync(join(root, ".herta", "attachments", sid, "a.png"), PNG);
    }
    return root;
  }

  it("takes only this session's own stored copies, and nothing the user withdrew", async () => {
    const root = workspace();
    const record: TerminalRecord = [
      { kind: "user", text: "看图" },
      row(".herta/attachments/s1/a.png"),
      row(".herta/attachments/s2/a.png"),
      row(".herta/attachments/s1/b.png", "removed"),
    ];
    const plan = await planExecutorPictures({
      record,
      freshFrom: 0,
      supported: true,
      root,
      sessionId: "s1",
    });
    expect(plan.unsupported).toBe(0);
    const carried = plan.messages.filter(
      (m) => m.role === "user" && m.images?.length,
    );
    expect(carried).toHaveLength(1);
    expect(carried[0]?.role === "user" ? carried[0].text : "").toContain(
      ".herta/attachments/s1/a.png",
    );
    const other = plan.messages.find(
      (m) => m.role === "user" && m.text.includes("attachments/s2/"),
    );
    expect(other).toMatchObject({ role: "user" });
    expect(other?.role === "user" ? other.images : "absent").toBeUndefined();
    expect(other?.role === "user" ? other.text : "").toContain(
      "not sent to you",
    );
    expect(
      plan.messages.some((m) => m.role === "user" && m.text.includes("b.png")),
    ).toBe(false);
  });

  it("withholds every picture from an executor that is not verified, and counts them", async () => {
    const root = workspace();
    const plan = await planExecutorPictures({
      record: [
        { kind: "user", text: "看图" },
        row(".herta/attachments/s1/a.png"),
      ],
      freshFrom: 0,
      supported: false,
      root,
      sessionId: "s1",
    });
    expect(plan.unsupported).toBe(1);
    expect(plan.messages).toHaveLength(1);
    expect(
      plan.messages[0]?.role === "user" ? plan.messages[0].images : "x",
    ).toBeUndefined();
  });

  it("reads each stored copy once per turn when the persona's plan already read it", async () => {
    const root = workspace();
    const opts = {
      record: [
        { kind: "user", text: "看图" },
        row(".herta/attachments/s1/a.png"),
      ] as TerminalRecord,
      freshFrom: 0,
      supported: true,
      root,
      sessionId: "s1",
      cache: new Map(),
    };
    const one = await planExecutorPictures(opts);
    const two = await planExecutorPictures(opts);
    const image = (plan: typeof one) =>
      plan.messages.flatMap((m) =>
        m.role === "user" ? (m.images ?? []) : [],
      )[0];
    expect(image(one)).toBeDefined();
    // The same picture object both times: read once, and digested once by the fingerprint.
    expect(image(two)).toBe(image(one));
  });

  it("names only the newest eight pictures it does not hand over, in one message", async () => {
    const root = workspace();
    const path = (n: number) => `.herta/attachments/s1/p${n}.png`;
    for (let n = 0; n < 20; n++)
      writeFileSync(join(root, ...path(n).split("/")), picture(n));
    const record: TerminalRecord = [
      { kind: "user", text: "看图" },
      ...Array.from({ length: 20 }, (_, n) => row(path(n))),
    ];
    const textOf = (m: NeutralMessage | undefined) =>
      m?.role === "user" ? m.text : "";
    const range = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => from + i);
    // Every row earlier than the message (freshFrom at the end): the newest eight go.
    const opts = { record, freshFrom: record.length, root, sessionId: "s1" };
    const seeing = await planExecutorPictures({ ...opts, supported: true });
    expect(seeing.messages).toHaveLength(9);
    expect(seeing.messages.slice(0, 8).map(textOf)).toEqual(
      range(12, 20).map((n) => expect.stringContaining(path(n))),
    );
    const rest = textOf(seeing.messages[8]);
    expect(rest).toContain("[User attachments: 12 pictures not sent to you]");
    for (const n of range(4, 12)) expect(rest).toContain(path(n));
    for (const n of range(0, 4)) expect(rest).not.toContain(path(n));
    expect(rest).toContain("(and 4 older ones)");
    expect(rest).toContain("12 because a request carries at most 8 pictures");
    // Not verified: nothing goes, all twenty are counted, the newest eight are named.
    const blind = await planExecutorPictures({ ...opts, supported: false });
    expect(blind.unsupported).toBe(20);
    expect(blind.messages).toHaveLength(1);
    const none = textOf(blind.messages[0]);
    expect(none).toContain("[User attachments: 20 pictures not sent to you]");
    for (const n of range(12, 20)) expect(none).toContain(path(n));
    for (const n of range(0, 12)) expect(none).not.toContain(path(n));
    expect(none).toContain("(and 12 older ones)");
    expect(none).toContain(
      "20 because the executor model is not verified for image input",
    );
  });
});

describe("NeutralBackendProvider carries the delegation's pictures (F02)", () => {
  const connection = provider("executor", "supported");
  const frame: BackendPromptFrame = {
    backendSystem:
      "Current actual user task and execution contract are quoted here.",
    scopedRepoInstructions: "",
    scopedMemory: "",
    messages: [],
    toolSchemas: [],
  };
  const turn = (turnId: string) => ({
    snapshot: {
      sessionId: "s1",
      turnId,
      bindings: {
        persona: { providerId: "persona", modelId: "persona-model" },
        executor: { providerId: connection.id, modelId: "executor-model" },
      },
      persona: connection,
      executor: connection,
    },
    personaKey: null,
    executorKey: null,
  });
  const image = {
    mimeType: "image/png" as const,
    data: PNG.toString("base64"),
  };
  const rowMessage: NeutralMessage = {
    role: "user",
    text: "[User attachment: picture]\nscreen.png",
    images: [image],
  };
  function adapterWith(outcomes: Outcome[]) {
    const requests: ModelRequest[] = [];
    const adapter: ProtocolAdapter = {
      protocol: connection.protocol,
      listModels: async () => ({ models: [], nextCursor: null }),
      async *stream(request) {
        requests.push(request);
        const outcome = outcomes.shift() ?? { kind: "reply" };
        if (outcome.kind === "http")
          throw new ProviderError({
            code: "http",
            status: outcome.status,
            message: `Provider HTTP ${outcome.status}`,
            retryable: false,
          });
        yield { type: "finished", reason: "stop" };
      },
    };
    return { requests, adapter };
  }
  async function consume(provider: NeutralBackendProvider) {
    for await (const _event of provider.streamChat(
      frame,
      new AbortController().signal,
    )) {
      /* drain */
    }
  }

  it("puts the turn's pictures right after the anchor, the same objects on every step, and only for that turn", async () => {
    const { requests, adapter } = adapterWith([]);
    const provider = new NeutralBackendProvider(() => adapter);
    provider.turn = turn("t1");
    const set: ExecutorPictureSet = { turnId: "t1", messages: [rowMessage] };
    provider.pictures = set;
    await consume(provider);
    await consume(provider);
    expect(requests[0]?.messages[1]).toBe(rowMessage);
    expect(requests[1]?.messages[1]).toBe(rowMessage);
    expect(requests[0]?.messages[0]).toEqual(requests[1]?.messages[0]);
    expect(set.accepted).toBe(true);
    // Another turn never sees them, even while the holder still points at them.
    provider.turn = turn("t2");
    await consume(provider);
    expect(
      requests[2]?.messages.some((m) => m.role === "user" && m.images?.length),
    ).toBe(false);
  });

  it("records a refusal of its pictures on the set, before any request carrying them went through", async () => {
    const { adapter } = adapterWith([{ kind: "http", status: 422 }]);
    const provider = new NeutralBackendProvider(() => adapter);
    provider.turn = turn("t1");
    const set: ExecutorPictureSet = { turnId: "t1", messages: [rowMessage] };
    provider.pictures = set;
    await expect(consume(provider)).rejects.toMatchObject({
      code: "http",
      status: 422,
    });
    expect(set.refusal).toEqual({ code: "image-rejected", status: 422 });
  });

  it("leaves the set alone for a refusal after its pictures went through, or without pictures", async () => {
    const accepted = adapterWith([
      { kind: "reply" },
      { kind: "http", status: 400 },
    ]);
    const provider = new NeutralBackendProvider(() => accepted.adapter);
    provider.turn = turn("t1");
    const set: ExecutorPictureSet = { turnId: "t1", messages: [rowMessage] };
    provider.pictures = set;
    await consume(provider);
    await expect(consume(provider)).rejects.toMatchObject({ status: 400 });
    expect(set.refusal).toBeUndefined();
    const none = adapterWith([{ kind: "http", status: 400 }]);
    const bare = new NeutralBackendProvider(() => none.adapter);
    bare.turn = turn("t1");
    const empty: ExecutorPictureSet = { turnId: "t1", messages: [] };
    bare.pictures = empty;
    await expect(consume(bare)).rejects.toMatchObject({ status: 400 });
    expect(empty.refusal).toBeUndefined();
  });
});

describe("pictures the user turned off (F04)", () => {
  const STOPPED = "the user turned off sending it to models";
  /** A picture row as the workbench addresses it: its record index and stored path. */
  const pictureRow = (record: TerminalRecord, name: string) => {
    const index = record.findIndex(
      (b) =>
        b.kind === "system" &&
        b.digest?.kind === "attachment" &&
        b.digest.name === name,
    );
    const block = record[index];
    if (block?.kind !== "system" || block.digest?.kind !== "attachment")
      throw new Error(`no picture row ${name}`);
    return { index, path: block.digest.path };
  };
  const rowIn = (seen: Seen, name: string) =>
    textOf(
      seen.messages.find((m) => m.role === "user" && m.text.includes(name)),
    );
  const modelUse = (record: TerminalRecord, index: number) => {
    const block = record[index];
    return block?.kind === "system" && block.digest?.kind === "attachment"
      ? (block.digest.modelUse ?? "absent")
      : "not a picture row";
  };

  it("a failed bulk picture choice leaves disk and the session unchanged, then a retry changes all pictures", async () => {
    const { root, host } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([
      picked("a.png", picture(1)),
      picked("b.png", picture(2)),
    ]);
    await session.submitText("两张图");
    const targets = [
      pictureRow(session.record, "a.png"),
      pictureRow(session.record, "b.png"),
    ];
    const file = join(
      root,
      ".herta",
      "transcript",
      "v2",
      `${session.sessionId}.jsonl`,
    );
    const diskBefore = readFileSync(file, "utf8"),
      recordBefore = structuredClone(session.record);
    const write = vi
      .spyOn(V2RecordPersister.prototype, "replaceBlocksAt")
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      });
    try {
      await expect(async () =>
        session.setPictureModelUse!(targets, "stop"),
      ).rejects.toThrow("disk full");
      expect(write).toHaveBeenCalledTimes(1);
      expect(readFileSync(file, "utf8")).toBe(diskBefore);
      expect(session.record).toEqual(recordBefore);
      expect(await session.setPictureModelUse!(targets, "stop")).toEqual({
        ok: true,
        changed: 2,
      });
      expect(write).toHaveBeenCalledTimes(2);
      expect(targets.map((t) => modelUse(session.record, t.index))).toEqual([
        "stopped",
        "stopped",
      ]);
      expect(
        readFileSync(file, "utf8").match(/"modelUse":"stopped"/g),
      ).toHaveLength(2);
    } finally {
      write.mockRestore();
    }
    script.seen = [];
    await session.submitText("只讨论文字");
    expect(images(personaRequests()[0]!)).toEqual([]);
    expect(images(executorRequests()[0]!)).toEqual([]);
  });

  it("leaves a turned-off picture out of the persona's and the executor's requests, says why, and keeps the row and its file", async () => {
    const { root, host } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("old.png", picture(1))]);
    await session.submitText("第一张");
    await session.attachFiles!([picked("new.png", picture(2))]);
    await session.submitText("第二张");
    const old = pictureRow(session.record, "old.png");
    const recent = pictureRow(session.record, "new.png");
    expect(await session.setPictureModelUse!([old], "stop")).toEqual({
      ok: true,
      changed: 1,
    });
    script.seen = [];
    await session.submitText("继续");
    const persona = personaRequests()[0]!;
    expect(images(persona)).toEqual([sha(picture(2))]);
    expect(rowIn(persona, "old.png")).toContain(
      "[User attachment: picture, not sent]",
    );
    expect(rowIn(persona, "old.png")).toContain(
      `The picture was not sent to you (${STOPPED}).`,
    );
    const run = executorRequests()[0]!;
    expect(images(run)).toEqual([sha(picture(2))]);
    expect(userText(run)).toContain(`1 because ${STOPPED}`);
    // Kept: the row and its stored copy; nothing about a withheld picture in the record.
    expect(modelUse(session.record, old.index)).toBe("stopped");
    expect(statSync(join(root, ...old.path.split("/"))).isFile()).toBe(true);
    expect(notes(session.record, WITHHELD)).toHaveLength(0);
    // The round's evidence, row by row, for both requests.
    const outcomes = [
      { ...old, outcome: "stopped" },
      { ...recent, outcome: "sent" },
    ];
    expect((await session.getRoundSummaries!()).at(-1)?.pictures).toEqual({
      persona: outcomes,
      executor: outcomes,
    });
  });

  it("turning off a newer picture makes room for an older one; turning it on again restores the ceiling's choice", async () => {
    const { root, host } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!(
      [1, 2, 3, 4, 5].map((n) => picked(`p${n}.png`, picture(n))),
    );
    await session.submitText("第一批");
    await session.attachFiles!(
      [6, 7, 8, 9].map((n) => picked(`p${n}.png`, picture(n))),
    );
    await session.submitText("第二批");
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => sha(picture(from + i)));
    const newest = pictureRow(session.record, "p9.png");
    expect(await session.setPictureModelUse!([newest], "stop")).toEqual({
      ok: true,
      changed: 1,
    });
    script.seen = [];
    await session.submitText("只对比较早的");
    expect(images(personaRequests()[0]!)).toEqual(range(1, 8));
    expect(images(executorRequests()[0]!)).toEqual(range(1, 8));
    expect(await session.setPictureModelUse!([newest], "send")).toEqual({
      ok: true,
      changed: 1,
    });
    script.seen = [];
    await session.submitText("再看全部");
    expect(images(personaRequests()[0]!)).toEqual(range(2, 9));
    expect(rowIn(personaRequests()[0]!, "p1.png")).toContain(
      "at most 8 pictures",
    );
    const persona = (await session.getRoundSummaries!()).at(-1)?.pictures
      ?.persona;
    const oldest = pictureRow(session.record, "p1.png");
    expect(persona?.find((p) => p.index === oldest.index)).toEqual({
      ...oldest,
      outcome: "over_limit",
    });
    expect(persona?.find((p) => p.index === newest.index)?.outcome).toBe(
      "sent",
    );
  });

  it("a persona not verified for images: a turned-off picture is not handed on, and she is not told it is (F02 design 2.8)", async () => {
    const { root, host } = fixture({
      persona: "unknown",
      executor: "supported",
    });
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("p1.png", picture(1))]);
    await session.submitText("第一张");
    await session.attachFiles!([picked("p2.png", picture(2))]);
    await session.submitText("第二张");
    expect(
      await session.setPictureModelUse!(
        [pictureRow(session.record, "p1.png")],
        "stop",
      ),
    ).toEqual({ ok: true, changed: 1 });
    script.seen = [];
    await session.submitText("继续");
    const persona = personaRequests()[0]!;
    expect(images(persona)).toEqual([]);
    expect(rowIn(persona, "p1.png")).toContain(STOPPED);
    expect(rowIn(persona, "p1.png")).not.toContain(HANDED_ON);
    expect(rowIn(persona, "p2.png")).toContain(HANDED_ON);
    expect(images(executorRequests()[0]!)).toEqual([sha(picture(2))]);
  });

  it("a picture turned off while a question waits is not sent with the answer, nor handed to the delegation after it", async () => {
    script.persona = "ask";
    const { root, host } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png", PNG)]);
    await session.submitText("按截图修改");
    const pending = session.getPendingUserInput?.();
    expect(pending).not.toBeNull();
    expect(images(personaRequests()[0]!)).toEqual([sha(PNG)]);
    // The question waits with the session idle: the picture can be turned off now.
    expect(session.turnInFlight).toBe(false);
    expect(
      await session.setPictureModelUse!(
        [pictureRow(session.record, "screen.png")],
        "stop",
      ),
    ).toEqual({ ok: true, changed: 1 });
    await session.answerUserInput?.({
      schemaVersion: 1,
      requestId: pending!.requestId,
      sessionId: pending!.sessionId,
      turnId: pending!.turnId,
      action: "answer",
      answers: [{ questionId: "q", optionIds: [], text: "左上角" }],
    });
    await until(() => !session.turnInFlight && personaRequests().length === 3);
    const answered = personaRequests()[1]!;
    expect(images(answered)).toEqual([]);
    expect(userText(answered)).toContain(
      `The picture was not sent to you (${STOPPED}).`,
    );
    expect(userText(answered)).not.toContain(
      "The picture itself is attached to this message.",
    );
    expect(executorRequests()).toHaveLength(1);
    expect(images(executorRequests()[0]!)).toEqual([]);
    expect(userText(executorRequests()[0]!)).toContain(`1 because ${STOPPED}`);
  });

  it("a picture attached before the message and turned off before sending goes to no model, and does not stop the turn", async () => {
    const { root, host } = fixture({ persona: "unknown", executor: "unknown" });
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("draft.png", PNG)]);
    // “添加文件” writes the row at once, before the message is sent.
    const draft = pictureRow(session.record, "draft.png");
    expect(await session.setPictureModelUse!([draft], "stop")).toEqual({
      ok: true,
      changed: 1,
    });
    await session.submitText("不用看图，直接改");
    expect(images(personaRequests()[0]!)).toEqual([]);
    expect(rowIn(personaRequests()[0]!, "draft.png")).toContain(STOPPED);
    expect(images(executorRequests()[0]!)).toEqual([]);
    // Withheld by the user, not for want of an image check: no note says otherwise.
    expect(notes(session.record, WITHHELD)).toHaveLength(0);
    expect(notes(session.record, NOT_SHOWN)).toHaveLength(0);
  });

  it("records outcomes only for a request that went: none for a turn stopped first", async () => {
    const { root, host } = fixture({ persona: "unknown", executor: "unknown" });
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png", PNG)]);
    await expect(session.submitText("按截图修改")).rejects.toMatchObject({
      code: "image-unsupported",
    });
    expect(
      (await session.getRoundSummaries!()).at(-1)?.pictures,
    ).toBeUndefined();
    await session.submitText("那先不看图了");
    const screen = pictureRow(session.record, "screen.png");
    expect((await session.getRoundSummaries!()).at(-1)?.pictures).toEqual({
      persona: [{ ...screen, outcome: "unsupported" }],
      executor: [{ ...screen, outcome: "unsupported" }],
    });
  });

  it("refuses while a turn is running, and changes nothing", async () => {
    const { root, host } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("screen.png", PNG)]);
    const screen = pictureRow(session.record, "screen.png");
    script.executor = [{ kind: "hang" }];
    const running = session.submitText("按截图修改");
    const rejected = expect(running).rejects.toBeDefined();
    try {
      await until(() => executorRequests().length > 0);
      expect(await session.setPictureModelUse!([screen], "stop")).toEqual({
        ok: false,
        reason: "turn_in_progress",
      });
    } finally {
      await session.interrupt();
      await rejected;
    }
    expect(modelUse(session.record, screen.index)).toBe("absent");
  });

  it("keeps the choice in the record file: a reopened session still leaves the picture out", async () => {
    const { root, host } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.attachFiles!([picked("a.png", picture(1))]);
    await session.submitText("看图");
    const a = pictureRow(session.record, "a.png");
    const at = session.record[a.index]?.at;
    expect(at).toEqual(expect.any(String));
    expect(await session.setPictureModelUse!([a], "stop")).toEqual({
      ok: true,
      changed: 1,
    });
    await host.closeActiveSession();
    const reopened = await host.openSession({ sessionId: session.sessionId });
    expect(reopened.record[a.index]).toMatchObject({
      kind: "system",
      at,
      digest: { path: a.path, modelUse: "stopped" },
    });
    script.seen = [];
    await reopened.submitText("再看看");
    expect(images(personaRequests()[0]!)).toEqual([]);
    expect(rowIn(personaRequests()[0]!, "a.png")).toContain(STOPPED);
  });
});
