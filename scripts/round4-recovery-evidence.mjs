/** Deterministic protocol transport, actual compiled SessionHost/tools/journal.
 * No external API, secrets or personal profile access. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const profile = resolve(".verification/round-4/profile-recovery");
const project = join(profile, "中文 恢复项目");
const evidence = resolve("docs/reports/evidence/round-4");
assert(
  !existsSync(join(project, "此前完成（不可重放）.txt")),
  "Fixture already exists; preserve prior evidence and use a new isolated profile for a new run.",
);
mkdirSync(project, { recursive: true });
mkdirSync(evidence, { recursive: true });
const requests = [];
let pause = true;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  assert.equal(new URL(url).hostname, "recovery.invalid");
  const request = JSON.parse(options.body);
  requests.push({
    model: request.model,
    hasToolResults: request.messages.some((m) => m.role === "tool"),
  });
  const executor = request.model === "executor-model";
  const hasResults = request.messages.some((m) => m.role === "tool");
  if (executor && hasResults && pause) {
    options.signal.throwIfAborted();
    return await new Promise((_resolve, reject) =>
      options.signal.addEventListener(
        "abort",
        () => reject(options.signal.reason),
        { once: true },
      ),
    );
  }
  const delegate = request.tools?.some(
    (t) => t.function.name === "delegate_execution",
  );
  const call = delegate
    ? {
        id: "delegate-1",
        type: "function",
        function: { name: "delegate_execution", arguments: "{}" },
      }
    : executor && !hasResults
      ? {
          id: "write-1",
          type: "function",
          function: {
            name: "write_new_file",
            arguments: JSON.stringify({
              path: "此前完成（不可重放）.txt",
              content: "R4 actual isolated file; deterministic transport\n",
            }),
          },
        }
      : null;
  const delta = call
    ? { tool_calls: [{ index: 0, ...call }] }
    : {
        content: executor
          ? "Execution evidence recorded."
          : "确定性测试传输：请以恢复执行事实卡片为准。",
      };
  const chunks = [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    {
      choices: [
        { index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" },
      ],
    },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
};
const { createSessionHost } = await import(
  "../packages/app-server/dist/index.js"
);
const provider = (id) => ({
  id,
  name: `R4 deterministic ${id}`,
  protocol: "openai-chat-completions",
  baseURL: "https://recovery.invalid/v1",
  authentication: "none",
  credentialRef: null,
  allowRemoteHTTP: false,
  revision: 1,
  defaults: { model: `${id}-model`, timeoutMs: 30000 },
  models: [
    {
      id: `${id}-model`,
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
});
const persona = provider("persona"),
  executor = provider("executor");
const config = {
  workspaceRoot: profile,
  backendContract: "standard",
  transcriptDir: join(profile, ".herta", "transcript", "v2"),
  projectMemoryDir: join(profile, ".herta", "memory"),
  userMemoryDir: join(profile, ".herta", "user-memory"),
  narrativeDir: join(profile, ".herta", "narrative"),
  dream: false,
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
  },
};
const host = createSessionHost(config);
const until = async (check) => {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Evidence wait timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const fileEvidence = () => {
  const path = join(project, "此前完成（不可重放）.txt");
  const bytes = readFileSync(path);
  return {
    path,
    bytesUtf8: bytes.toString("utf8"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mtimeMs: statSync(path).mtimeMs,
  };
};
try {
  const session = await host.createSession({
    workspaceRoot: profile,
    backendWorkspace: project,
    lang: "zh",
  });
  await session.setWorkspaceTrust("workspace");
  const running = session.submitText(
    "隔离恢复验收（确定性传输，无真实 API）：创建此前完成（不可重放）.txt。",
  );
  const completion = running.then(
    () => ({ failed: false }),
    () => ({ failed: true }),
  );
  await until(() =>
    requests.some((r) => r.model === "executor-model" && r.hasToolResults),
  );
  await session.interrupt();
  assert.equal((await completion).failed, true);
  await until(() => session.resumable === true);
  const before = fileEvidence();
  await host.closeActiveSession();
  const requestCount = requests.length;
  const reopened = await host.openSession({ sessionId: session.sessionId });
  assert.equal(
    requests.length,
    requestCount,
    "Opening history must not request or execute",
  );
  pause = false;
  await reopened.continueInterrupted();
  await until(() => reopened.resumable === false);
  const after = fileEvidence();
  assert.deepEqual(after, before, "Completed file must not be replayed");
  const facts = reopened.record.filter(
    (b) => b.kind === "system" && b.recoverySummary,
  );
  assert(
    facts.some((b) =>
      b.recoverySummary.steps.some(
        (s) =>
          s.callId === "write-1" &&
          s.phase === "previously-completed" &&
          s.outcome === "succeeded",
      ),
    ),
  );
  await host.closeActiveSession();
  const persisted = await host.openSession({ sessionId: session.sessionId });
  assert(
    persisted.record.some((b) => b.kind === "system" && b.recoverySummary),
  );
  const metadata = {
    kind: "deterministic transport; actual compiled protocol adapter, SessionHost, tools and filesystem; no external API",
    sessionId: session.sessionId,
    profile,
    backendWorkspace: project,
    sessionFile: join(config.transcriptDir, `${session.sessionId}.jsonl`),
    journalFile: join(
      config.transcriptDir,
      "journal",
      `${session.sessionId}.jsonl`,
    ),
    before,
    after,
    historyOpeningRequests: 0,
    explicitResumeRequests: requests.length - requestCount,
    recoverySummaries: facts.map((b) => b.recoverySummary),
    requests,
  };
  writeFileSync(
    join(evidence, "recovery-desktop-fixture.json"),
    JSON.stringify(metadata, null, 2),
  );
  console.log(
    JSON.stringify({
      sessionId: session.sessionId,
      profile,
      project,
      evidence: join(evidence, "recovery-desktop-fixture.json"),
      noReplay: true,
    }),
  );
} finally {
  await host.closeActiveSession();
  globalThis.fetch = originalFetch;
}
