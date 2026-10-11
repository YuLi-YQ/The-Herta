/** Actual loopback sockets + production protocol adapters, deterministic only.
 * Run after providers build. No API secrets or personal profile needed. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createProtocolAdapter } from "../packages/providers/dist/index.js";
import { startFaultService } from "./round4-fault-service.mjs";

const protocols = [
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
];
const service = await startFaultService();
const results = [];
const config = (protocol, mode, timeoutMs = 3000) => ({
  id: "r4-socket-fixture",
  name: "R4 deterministic local fixture",
  protocol,
  baseURL: `${service.baseURL}/${mode}/prefix/v1`,
  authentication: "none",
  credentialRef: null,
  allowRemoteHTTP: false,
  models: [],
  defaults: { model: "r4-fixture", timeoutMs },
  revision: 1,
});
const request = (signal, tools = []) => ({
  sessionId: "r4-fixture-session",
  turnId: "r4-fixture-turn",
  modelId: "r4-fixture",
  system: "Deterministic local test",
  messages: [{ role: "user", text: "R4:ID=socket" }],
  tools,
  options: {},
  signal,
});
async function run(
  protocol,
  mode,
  expected,
  { abort = false, tools = [] } = {},
) {
  const controller = new AbortController();
  const events = [];
  let timer;
  const started = performance.now();
  const adapter = createProtocolAdapter(
    config(protocol, mode, expected === "stall" ? 100 : 3000),
    null,
    { fetch },
  );
  if (abort)
    timer = setTimeout(
      () => controller.abort(new DOMException("User cancelled", "AbortError")),
      70,
    );
  let error;
  try {
    for await (const event of adapter.stream(request(controller.signal, tools)))
      events.push(event);
  } catch (caught) {
    error = caught;
  } finally {
    clearTimeout(timer);
  }
  if (expected) {
    assert(error, `${protocol} ${mode} must fail`);
    if (expected === "AbortError") assert.equal(error.name, expected);
    else assert.equal(error.code, expected);
    assert(
      !events.some((e) => e.type === "finished"),
      "failure must never finish",
    );
    if (expected !== "AbortError") assert.equal(error.retryable, false);
  } else
    assert(
      events.some((e) => e.type === "finished"),
      `${protocol} ${mode} must complete`,
    );
  if (["drop", "stall-body"].includes(mode))
    assert(
      events.some((e) => e.type === "text-delta"),
      "must preserve actual partial stream",
    );
  const count = service.records.length;
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(service.records.length, count, "must not retry socket request");
  const last = service.records.at(-1);
  assert.equal(
    last.closed,
    true,
    "HTTP response must be closed after completion/failure/cancel",
  );
  const result = {
    protocol,
    mode,
    deterministicFixture: true,
    passed: true,
    elapsedMs: Math.round(performance.now() - started),
    events: events.map((e) => e.type),
    ...(error
      ? {
          error: {
            name: error.name,
            code: error.code,
            retryable: error.retryable,
            status: error.status,
          },
        }
      : {}),
    request: last,
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
try {
  for (const protocol of protocols) {
    await run(protocol, "normal", null);
    const adapter = createProtocolAdapter(config(protocol, "normal"), null, {
      fetch,
    });
    const models = await adapter.listModels({
      signal: new AbortController().signal,
    });
    assert.deepEqual(
      models.models.map((m) => m.id),
      ["r4-fixture"],
    );
    await run(protocol, "normal", null, {
      tools: [
        {
          name: "herta_probe",
          description: "No-side-effect echo",
          inputSchema: {
            type: "object",
            properties: { nonce: { type: "string", enum: ["fixture-nonce"] } },
            required: ["nonce"],
            additionalProperties: false,
          },
        },
      ],
    });
    assert(results.at(-1).events.includes("tool-call-ready"));
    await run(protocol, "hold", "stall");
    await run(protocol, "stall-body", "stall");
    await run(protocol, "unavailable", "http");
    assert.equal(results.at(-1).error.status, 503);
    await run(protocol, "drop", "sse");
    await run(protocol, "hold", "AbortError", { abort: true });
    await run(protocol, "long", "AbortError", { abort: true });
  }
  // A genuinely closed listener verifies the network-unavailable branch, rather
  // than replacing fetch with a rejected Promise.
  const closedService = await startFaultService();
  const closedURL = closedService.baseURL;
  await closedService.close();
  for (const protocol of protocols) {
    const adapter = createProtocolAdapter(
      { ...config(protocol, "normal"), baseURL: `${closedURL}/prefix/v1` },
      null,
      { fetch },
    );
    await assert.rejects(
      async () => {
        for await (const _event of adapter.stream(
          request(new AbortController().signal),
        )) {
          assert.fail("Closed listener must never emit events");
        }
      },
      (error) => error.code === "network" && error.retryable === false,
    );
    const result = {
      protocol,
      mode: "closed-listener",
      deterministicFixture: true,
      passed: true,
      error: { code: "network", retryable: false },
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const rejectedAuth = await fetch(
    `${service.baseURL}/normal/prefix/v1/responses`,
    {
      method: "POST",
      headers: { Authorization: "Bearer fixture-non-secret" },
      body: "{}",
    },
  );
  assert.equal(
    rejectedAuth.status,
    400,
    "Local fixture must reject credentials",
  );
  await rejectedAuth.text();
  const evidence = resolve("docs/reports/evidence/round-4");
  mkdirSync(evidence, { recursive: true });
  writeFileSync(
    resolve(evidence, "core-socket-results.json"),
    JSON.stringify(
      {
        scope: "deterministic loopback HTTP socket fixture, not external API",
        actualRequests: service.records.length,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await service.close();
}
