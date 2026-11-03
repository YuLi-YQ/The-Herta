import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProviderConfig, setProviderFetch } from "@herta/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionHost } from "./session-host.js";
import { removeTmpDir } from "./testing/tmp-workspace.js";
import type { AppServerConfig, SessionHost } from "./types.js";

/**
 * The workbench through the real protocol adapter (R52). neutral-session.test.ts
 * replaces createProtocolAdapter wholesale, so it never reaches the DeepSeek
 * wire format, the web tools the adapter runs itself, or their replay into the
 * next persona pass. Here only the network is scripted — through
 * setProviderFetch, the hook the desktop main process installs Chromium's fetch
 * with — and everything from the session host down to the request bodies is
 * shipping code. The key is a placeholder and no request leaves the process:
 * this is not an API pass.
 */

interface Wire {
  url: URL;
  // biome-ignore lint/suspicious/noExplicitAny: a parsed wire body, asserted field by field
  body: any;
  auth: string | null;
}

const sse = (chunks: unknown[]) =>
  new Response(
    `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
const answer = (content: string) =>
  sse([
    { choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
  ]);
const call = (id: string, name: string, args: unknown) =>
  sse([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    },
  ]);

/** Answers each request with the next step, in order; anything past the
 *  script is recorded and refused. */
function scripted(
  steps: ((init?: RequestInit) => Response | Promise<Response>)[],
) {
  const wires: Wire[] = [];
  const unexpected: string[] = [];
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    wires.push({
      url,
      body: JSON.parse(String(init?.body ?? "null")),
      auth: new Headers(init?.headers).get("authorization"),
    });
    const step = steps.shift();
    if (step) return step(init);
    unexpected.push(url.pathname);
    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;
  return { fetcher, wires, unexpected };
}

const tools = (wire: Wire): string[] =>
  (wire.body?.tools ?? []).map(
    (t: { function: { name: string } }) => t.function.name,
  );
const roles = (wire: Wire): string[] =>
  wire.body.messages.map((m: { role: string }) => m.role);

/** One DeepSeek connection bound to both roles, as a user would set it up. */
const deepseek: ProviderConfig = {
  id: "deepseek",
  name: "DeepSeek",
  protocol: "openai-chat-completions",
  baseURL: "https://api.deepseek.com",
  authentication: "api-key",
  credentialRef: "placeholder",
  allowRemoteHTTP: false,
  revision: 1,
  models: [
    {
      id: "deepseek-flash",
      source: "manual",
      capabilities: {
        streaming: "supported",
        tools: "supported",
        images: "unknown",
        reasoning: "unknown",
      },
      validation: {
        state: "tools-available",
        protocol: "openai-chat-completions",
        providerRevision: 1,
      },
    },
  ],
  defaults: { model: "deepseek-flash", timeoutMs: 5000 },
};

const roots: string[] = [];
const hosts: SessionHost[] = [];
afterEach(async () => {
  setProviderFetch(undefined);
  vi.unstubAllGlobals();
  for (const host of hosts.splice(0)) await host.closeActiveSession();
  for (const root of roots.splice(0)) await removeTmpDir(root);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "herta-r52-deepseek-web-"));
  roots.push(root);
  writeFileSync(join(root, "notes.txt"), "R52 本地记录：发布前核对标签。\n");
  let releases = 0;
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
          persona: deepseek,
          executor: deepseek,
          bindings: {
            persona: {
              providerId: deepseek.id,
              modelId: "deepseek-flash",
              webSearch: true,
            },
            executor: { providerId: deepseek.id, modelId: "deepseek-flash" },
          },
        },
        personaKey: "placeholder-key",
        executorKey: "placeholder-key",
        release: () => {
          releases++;
        },
      }),
    },
  };
  const host = createSessionHost(config);
  hosts.push(host);
  return { root, host, releases: () => releases };
}

describe("Workbench through the real DeepSeek adapter (scripted network only)", () => {
  it("persona searches, delegates, the executor reads a file, and the conclusion replays the search", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("No real network in this test");
    });
    const question = "查一下发布前要核对什么，再看看本地 notes.txt。";
    const source = "https://example.com/herta-release";
    const { fetcher, wires, unexpected } = scripted([
      () => call("s1", "web_search", { query: "Herta 发布 核对" }),
      () =>
        Response.json({
          results: [
            {
              title: "发布说明",
              url: source,
              summary: "发布前核对标签与说明。",
              site_name: "示例",
              date: "2026-10-20T00:00:00Z",
            },
          ],
        }),
      () => call("d1", "delegate_execution", {}),
      () => call("r1", "read_file", { path: "notes.txt" }),
      () => answer("已读取 notes.txt：发布前核对标签。"),
      () =>
        answer("结论：本地记录要求发布前核对标签，与搜索到的发布说明一致。"),
    ]);
    setProviderFetch(fetcher);
    const { root, host, releases } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.setWorkspaceTrust?.("workspace");
    const result = await session.submitText(question);
    expect("turnId" in result).toBe(true);
    expect(unexpected).toEqual([]);

    // Every request went to DeepSeek with the bound key; one search, no page reads.
    expect(wires.map((w) => `${w.url.host}${w.url.pathname}`)).toEqual([
      "api.deepseek.com/chat/completions",
      "api.deepseek.com/v1/tools/search",
      "api.deepseek.com/chat/completions",
      "api.deepseek.com/chat/completions",
      "api.deepseek.com/chat/completions",
      "api.deepseek.com/chat/completions",
    ]);
    expect(wires.every((w) => w.auth === "Bearer placeholder-key")).toBe(true);
    const [first, search, afterSearch, executor, executorNext, conclusion] =
      wires as [Wire, Wire, Wire, Wire, Wire, Wire];

    // Persona pass 1: its own tools plus the adapter's web tools, full budget.
    expect(tools(first)).toEqual(
      expect.arrayContaining([
        "delegate_execution",
        "request_user_input",
        "web_search",
        "web_fetch",
      ]),
    );
    expect(first.body.messages[0].content).toContain(
      "at most 3 web operations",
    );
    expect(search.body).toEqual({
      query: "Herta 发布 核对",
      ori_question: question,
      count: 5,
      need_content: false,
    });
    expect(roles(afterSearch)).toEqual(["system", "user", "assistant", "tool"]);
    expect(
      JSON.parse(afterSearch.body.messages[3].content).results[0].url,
    ).toBe(source);

    // The executor gets the file tools, never web tools or the persona's search.
    expect(tools(executor)).toContain("read_file");
    for (const name of ["web_search", "web_fetch", "delegate_execution"])
      expect(tools(executor)).not.toContain(name);
    expect(JSON.stringify(executor.body.messages)).not.toContain(source);
    const read = executorNext.body.messages.at(-1);
    expect(read).toMatchObject({ role: "tool", tool_call_id: "r1" });
    expect(read.content).toContain("发布前核对标签");

    // Persona pass 2 replays the private search round before the delegation,
    // with a spent budget unit and no second delegation offered.
    expect(roles(conclusion)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
    const sent = conclusion.body.messages;
    expect(sent[2].tool_calls[0]).toMatchObject({
      id: "s1",
      function: { name: "web_search" },
    });
    expect(sent[3].tool_call_id).toBe("s1");
    expect(sent[4].tool_calls[0]).toMatchObject({
      id: "d1",
      function: { name: "delegate_execution" },
    });
    expect(sent[5].tool_call_id).toBe("d1");
    expect(sent[0].content).toContain("at most 2 web operations");
    expect(tools(conclusion)).not.toContain("delegate_execution");

    // What the user sees: the conclusion, and the search with its source.
    const speech = session.record.filter(
      (b) => b.kind === "herta" && b.surface === "speech",
    );
    expect(speech.at(-1)).toMatchObject({
      text: "结论：本地记录要求发布前核对标签，与搜索到的发布说明一致。",
    });
    const searches = (await session.getRoundSummaries?.())?.at(-1)?.searches;
    expect(searches?.some((s) => s.status === "completed")).toBe(true);
    expect(JSON.stringify(searches)).toContain(source);
    expect(releases()).toBe(1);
  });
  // R61: the failure and cancel branches through the same shipping chain.
  it("reports a failed search to the persona, which answers without it", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("No real network in this test");
    });
    const { fetcher, wires, unexpected } = scripted([
      () => call("s1", "web_search", { query: "Herta 发布" }),
      () => Response.json({ error: {} }, { status: 500 }),
      () => answer("搜索失败，以下回答没有使用联网结果。"),
    ]);
    setProviderFetch(fetcher);
    const { root, host, releases } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.setWorkspaceTrust?.("workspace");
    await session.submitText("查一下最新发布说明。");
    expect(unexpected).toEqual([]);
    expect(wires.map((w) => w.url.pathname)).toEqual([
      "/chat/completions",
      "/v1/tools/search",
      "/chat/completions",
    ]);
    const told = JSON.parse(wires[2]?.body.messages.at(-1).content);
    expect(told.error).toContain("search failed");
    const speech = session.record.filter(
      (b) => b.kind === "herta" && b.surface === "speech",
    );
    expect(speech.at(-1)).toMatchObject({
      text: "搜索失败，以下回答没有使用联网结果。",
    });
    const searches = (await session.getRoundSummaries?.())?.at(-1)?.searches;
    expect(searches?.some((s) => s.status === "failed")).toBe(true);
    expect(releases()).toBe(1);
  });

  it("stops cleanly when the user interrupts during a search, and the next turn starts fresh", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("No real network in this test");
    });
    const { fetcher, wires, unexpected } = scripted([
      () => call("s1", "web_search", { query: "很慢的搜索" }),
      (init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
      () => answer("好的，换个话题。"),
    ]);
    setProviderFetch(fetcher);
    const { root, host, releases } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.setWorkspaceTrust?.("workspace");
    const running = session.submitText("搜一下这个。");
    const outcome = running.then(
      () => "resolved",
      () => "rejected",
    );
    const deadline = Date.now() + 10_000;
    while (wires.length < 2) {
      if (Date.now() > deadline) throw new Error("search never started");
      await new Promise((r) => setTimeout(r, 10));
    }
    await session.interrupt();
    await outcome;
    expect(session.turnInFlight).toBe(false);
    expect(wires).toHaveLength(2);
    expect(releases()).toBe(1);

    await session.submitText("算了，聊点别的。");
    expect(unexpected).toEqual([]);
    expect(wires).toHaveLength(3);
    const next = wires[2] as Wire;
    expect(roles(next)).not.toContain("tool");
    expect(JSON.stringify(next.body.messages)).not.toContain("很慢的搜索");
    expect(releases()).toBe(2);
  });
  it("refuses a fourth search in one turn without a request and still finishes the turn", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("No real network in this test");
    });
    const found = (n: number) => () =>
      Response.json({
        results: [
          {
            title: `结果${n}`,
            url: `https://example.com/${n}`,
            summary: "摘要",
            site_name: "示例",
          },
        ],
      });
    const { fetcher, wires, unexpected } = scripted([
      () => call("s1", "web_search", { query: "一" }),
      found(1),
      () => call("s2", "web_search", { query: "二" }),
      found(2),
      () => call("s3", "web_search", { query: "三" }),
      found(3),
      () => answer("联网额度已用完，就这三条结果回答。"),
    ]);
    setProviderFetch(fetcher);
    const { root, host, releases } = fixture();
    const session = await host.createSession({ backendWorkspace: root });
    await session.setWorkspaceTrust?.("workspace");
    await session.submitText("多搜几次。");
    expect(unexpected).toEqual([]);
    expect(
      wires.filter((w) => w.url.pathname === "/v1/tools/search"),
    ).toHaveLength(3);
    const last = wires.at(-1) as Wire;
    // With the budget spent, the closing request withdraws only the web
    // tools: the persona can still delegate, and cannot fail the turn by
    // searching again (R61).
    expect(tools(last)).toEqual(
      expect.arrayContaining(["delegate_execution", "request_user_input"]),
    );
    expect(tools(last)).not.toContain("web_search");
    expect(tools(last)).not.toContain("web_fetch");
    expect(last.body.tool_choice).toBeUndefined();
    expect(last.body.messages[0].content).toContain(
      "The web tools are no longer available this turn",
    );
    const speech = session.record.filter(
      (b) => b.kind === "herta" && b.surface === "speech",
    );
    expect(speech.at(-1)).toMatchObject({
      text: "联网额度已用完，就这三条结果回答。",
    });
    expect(releases()).toBe(1);
  });
});
