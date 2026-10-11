import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import type { ProviderConfig, ProviderProtocol } from "../contracts.js";
import { createProtocolAdapter } from "./index.js";

const protocols: ProviderProtocol[] = [
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
];
const cap = 2 * 1024 * 1024;
function config(
  protocol: ProviderProtocol,
  baseURL: string,
  timeoutMs = 2000,
): ProviderConfig {
  return {
    id: "bounded-fixture",
    name: "Deterministic model metadata fixture",
    protocol,
    baseURL,
    authentication: "none",
    credentialRef: null,
    allowRemoteHTTP: false,
    models: [],
    defaults: { model: "manual", timeoutMs },
    revision: 1,
  };
}
it.each(
  protocols,
)("%s rejects an oversized chunked model response and closes the actual socket before parsing", async (protocol) => {
  let closed = false,
    requests = 0,
    sentBytes = 0;
  const payload = Buffer.from(
    JSON.stringify({ data: [{ id: "manual" }], padding: "x".repeat(cap * 2) }),
  );
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "application/json" });
    const timer = setInterval(() => {
      const part = payload.subarray(sentBytes, sentBytes + 65536);
      sentBytes += part.byteLength;
      res.write(part);
      if (sentBytes === payload.byteLength) {
        clearInterval(timer);
        res.end();
      }
    }, 2);
    res.on("close", () => {
      closed = true;
      clearInterval(timer);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const adapter = createProtocolAdapter(
      config(
        protocol,
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/prefix/v1`,
      ),
      null,
      { fetch },
    );
    await expect(
      adapter.listModels({ signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "sse",
      message: "Model list response exceeds 2 MiB limit",
      retryable: false,
    });
    for (let i = 0; i < 50 && !closed; i++)
      await new Promise((done) => setTimeout(done, 10));
    expect(closed).toBe(true);
    expect(requests).toBe(1);
    expect(sentBytes).toBeLessThan(payload.byteLength);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
});
it.each(
  protocols,
)("%s accepts a JSON model response exactly at the byte budget", async (protocol) => {
  const json = JSON.stringify({ data: [{ id: "manual" }] });
  const payload = json + " ".repeat(cap - Buffer.byteLength(json));
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(payload);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const adapter = createProtocolAdapter(
      config(
        protocol,
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      ),
      null,
      { fetch },
    );
    expect(
      await adapter.listModels({ signal: new AbortController().signal }),
    ).toEqual({ models: [{ id: "manual" }], nextCursor: null });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
});
it.each(
  protocols,
)("%s preserves timeout and user cancellation while model JSON body is stalled", async (protocol) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"data":[');
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const timeout = createProtocolAdapter(config(protocol, root, 50), null, {
      fetch,
    });
    await expect(
      timeout.listModels({ signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "stall", retryable: false });
    const controller = new AbortController();
    const cancelled = createProtocolAdapter(config(protocol, root), null, {
      fetch,
    }).listModels({ signal: controller.signal });
    const timer = setTimeout(
      () => controller.abort(new DOMException("User cancelled", "AbortError")),
      30,
    );
    try {
      await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clearTimeout(timer);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
});
