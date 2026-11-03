import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingHttpHeaders, IncomingMessage, ClientRequest } from "node:http";
import { Agent, globalAgent, type RequestOptions } from "node:https";
import { checkServerIdentity } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseExecutablePluginManifest } from "../../shared/executable-plugins.js";
import { PluginCapabilityBroker, type PluginCapabilityArguments, type PluginCapabilityContext } from "./capability-broker.js";
import { createPluginNetworkService, isPublicPluginAddress, PLUGIN_NETWORK_LIMITS, PluginNetworkFault, pluginNetworkDiagnostic, type PluginNetworkServiceOptions } from "./plugin-network-service.js";

interface Plan { status?: number; headers?: IncomingHttpHeaders; chunks?: Buffer[]; hold?: boolean; incomplete?: boolean; error?: string; errorCode?: string }
class Response extends Readable {
  statusCode: number; headers: IncomingHttpHeaders; complete = false;
  constructor(plan: Plan) { super(); this.statusCode = plan.status ?? 200; this.headers = plan.headers ?? { "content-type": "text/plain; charset=utf-8" }; }
  _read() {}
}
class Request extends EventEmitter {
  destroyed = false; body?: Buffer; response: Response;
  constructor(readonly options: RequestOptions, private readonly plan: Plan, private readonly receive: (response: IncomingMessage) => void) { super(); this.response = new Response(plan); }
  end(body?: Buffer) {
    this.body = body && Buffer.from(body);
    queueMicrotask(() => {
      if (this.destroyed) return;
      if (this.plan.error) { this.emit("error", Object.assign(Error(this.plan.error), { code: this.plan.errorCode })); return; }
      this.receive(this.response as unknown as IncomingMessage);
      if (this.plan.hold || this.response.destroyed) return;
      for (const chunk of this.plan.chunks ?? [Buffer.from("hello")]) { if (this.response.destroyed) break; this.response.emit("data", chunk); }
      if (!this.response.destroyed) {
        if (this.plan.incomplete) this.response.emit("close");
        else { this.response.complete = true; this.response.emit("end"); }
      }
    });
    return this;
  }
  destroy() { this.destroyed = true; this.response.destroy(); return this; }
}
const services: ReturnType<typeof createPluginNetworkService>[] = [];
function context() {
  const controller = new AbortController(); let live = true;
  const value: PluginCapabilityContext = { signal: controller.signal,
    binding: { pluginId: "example.network", actionId: "fetch", contentHash: "a".repeat(64), grantRevision: 1, sessionId: "synthetic", sessionRevision: 1, permissionRevision: 1, scope: "chat" },
    assertCurrent() { if (!live) throw Error("synthetic private policy detail"); } };
  return { value, controller, revoke() { live = false; } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(plan: Plan = {}, resolver?: PluginNetworkServiceOptions["resolve"]) {
  const resolve: NonNullable<PluginNetworkServiceOptions["resolve"]> = resolver ?? (async () => [{ address: "8.8.8.8", family: 4 as const }]);
  const requests: Request[] = [], resolving = vi.fn(resolve);
  const send = vi.fn((options: RequestOptions, receive: (message: IncomingMessage) => void) => {
    const request = new Request(options, plan, receive); requests.push(request); return request as unknown as ClientRequest;
  });
  const service = createPluginNetworkService({ resolve: resolving, request: send }); services.push(service);
  const c = context(); return { service, requests, resolving, send, ...c };
}
const args: PluginCapabilityArguments["network.request"] = { url: "https://example.com/resource?q=one", method: "GET" };
async function flush() { for (let index = 0; index < 6; index++) await Promise.resolve(); }
function fakeClock() { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }); }
afterEach(() => { for (const service of services.splice(0)) service.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("plugin HTTPS transport without real network access", () => {
  it("validates URL/method/body again before any resolver or transport", async () => {
    const f = fixture();
    for (const input of [
      { ...args, url: "http://example.com" }, { ...args, url: "https://user:secret@example.com" }, { ...args, url: "https://example.com/#fragment" },
      { ...args, url: "https://example.com/#" },
      { ...args, url: "https://example.com/\r\n" }, { ...args, url: "https://example.com:0/" }, { ...args, method: "CONNECT" }, { ...args, body: "not allowed on GET" },
      { ...args, method: "POST", body: "\ud800" }, { ...args, headers: { Authorization: "never" } },
    ]) await expect(f.service.request(input as typeof args, f.value)).rejects.toMatchObject({ code: "invalid-input", message: "invalid-input" });
    expect(f.resolving).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("rejects local/reserved/mapped/transition addresses and normalized numeric loopback URLs", async () => {
    for (const address of ["0.0.0.0", "10.2.3.4", "100.100.100.200", "127.0.0.1", "169.254.169.254", "172.31.255.255", "192.168.1.1", "192.0.2.1",
      "198.18.0.1", "198.51.100.2", "203.0.113.1", "224.0.0.1", "255.255.255.255", "168.63.129.16", "::", "::1", "::ffff:8.8.8.8",
      "::ffff:808:808", "64:ff9b::808:808", "fc00::1", "fe80::1%eth0", "2001::1", "2001:db8::1", "2002:808:808::1", "3fff::1"])
      expect(isPublicPluginAddress(address), address).toBe(false);
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) expect(isPublicPluginAddress(address)).toBe(true);
    const f = fixture();
    for (const url of ["https://2130706433/", "https://0x7f000001/", "https://[::ffff:7f00:1]/", "https://localhost/", "https://metadata.google.internal/", "https://private.local/"])
      await expect(f.service.request({ ...args, url }, f.value)).rejects.toMatchObject({ code: "capability-denied" });
    expect(f.resolving).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("refuses a mixed DNS answer, empty answer or oversized answer set without connecting", async () => {
    const cases: [readonly { address: string; family: 4 | 6 }[], string][] = [
      [[{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }], "capability-denied"],
      [[], "host-error"], [Array.from({ length: 17 }, () => ({ address: "8.8.8.8", family: 4 as const })), "resource-limit"],
    ];
    for (const [addresses, code] of cases) {
      const f = fixture({}, async () => addresses); await expect(f.service.request(args, f.value)).rejects.toMatchObject({ code }); expect(f.send).not.toHaveBeenCalled();
    }
  });
  it("pins a checked address while preserving hostname/TLS and sends only fixed headers without proxy inheritance", async () => {
    const text = "\uFEFF星河 🌌\r\n", f = fixture({ headers: { "content-type": "application/problem+json; charset=utf-8", "set-cookie": ["private-cookie"], location: "https://internal.invalid" }, chunks: [Buffer.from(text)] },
      async () => [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]);
    const received = JSON.parse(await f.service.request(args, f.value)), options = f.requests[0]!.options;
    expect(received).toEqual({ status: 200, ok: true, contentType: "application/problem+json", body: text });
    expect(Object.keys(received)).toEqual(["status", "ok", "contentType", "body"]);
    expect(options).toMatchObject({ protocol: "https:", hostname: "example.com", servername: "example.com", rejectUnauthorized: true, method: "GET", path: "/resource?q=one", family: 4 });
    expect(options.checkServerIdentity).toBe(checkServerIdentity); expect(options.agent).toBeInstanceOf(Agent); expect(options.agent).not.toBe(globalAgent);
    expect((options.agent as Agent).options).toMatchObject({ keepAlive: false, maxCachedSessions: 0, proxyEnv: {} });
    expect(options.headers).toEqual({ "Accept-Encoding": "identity" }); expect(options.auth).toBeUndefined(); expect(f.resolving).toHaveBeenCalledTimes(1);
    // Exercise pinning while the request is live in a second held response.
    const held = fixture({ hold: true }); const pending = held.service.request(args, held.value).catch(error => error); await flush();
    const lookup = held.requests[0]!.options.lookup!;
    for (const all of [false, true]) {
      const result = await new Promise((resolve, reject) => lookup("example.com", { all }, (error, address) => error ? reject(error) : resolve(address)));
      expect(result).toEqual(all ? [{ address: "8.8.8.8", family: 4 }] : "8.8.8.8");
    }
    expect(held.resolving).toHaveBeenCalledTimes(1); held.controller.abort(); await pending;
  });
  it("takes an owned input snapshot before awaiting DNS", async () => {
    const dns = deferred<readonly { address: string; family: 4 }[]>(), f = fixture({}, async () => dns.promise);
    const input = { url: args.url, method: "POST" as const, body: "原始正文" }, pending = f.service.request(input, f.value);
    input.url = "https://127.0.0.1/private"; input.body = "changed"; dns.resolve([{ address: "8.8.8.8", family: 4 }]);
    await pending; expect(f.requests[0]!.options.hostname).toBe("example.com"); expect(f.requests[0]!.body?.toString("utf8")).toBe("原始正文");
    expect(f.requests[0]!.options.headers).toMatchObject({ "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength("原始正文") });
  });
  it("supports the seven allowed methods, empty HEAD/204 responses and bounded non-success statuses", async () => {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
      const f = fixture({ status: 204, headers: {}, chunks: [] });
      expect(JSON.parse(await f.service.request({ ...args, method }, f.value))).toEqual({ status: 204, ok: true, contentType: "", body: "" });
    }
    const missing = fixture({ status: 404, chunks: [Buffer.from("not found")] });
    expect(JSON.parse(await missing.service.request(args, missing.value))).toEqual({ status: 404, ok: false, contentType: "text/plain", body: "not found" });
  });
  it("refuses redirects without following or exposing Location", async () => {
    const f = fixture({ status: 302, headers: { location: "https://169.254.169.254/private", "set-cookie": ["secret"] }, chunks: [] });
    await expect(f.service.request(args, f.value)).rejects.toMatchObject({ code: "capability-denied", message: "capability-denied" });
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.requests[0]!.destroyed).toBe(true);
  });
  it("refuses compression, unsupported types/charsets and malformed UTF8/binary text", async () => {
    for (const plan of [
      { headers: { "content-type": "text/plain", "content-encoding": "gzip" } }, { headers: { "content-type": "image/png" } },
      { headers: { "content-type": "text/plain; charset=utf-16" } }, { chunks: [Buffer.from([0xff, 0xfe])] }, { chunks: [Buffer.from([65, 0, 66])] },
    ]) { const f = fixture(plan); await expect(f.service.request(args, f.value)).rejects.toMatchObject({ code: "host-error" }); expect(f.requests[0]!.destroyed).toBe(true); }
  });
  it("bounds declared/streamed bytes and JSON expansion without returning truncated data", async () => {
    for (const plan of [
      { headers: { "content-type": "text/plain", "content-length": "65537" } },
      { chunks: [Buffer.alloc(32768, 65), Buffer.alloc(32769, 65)] },
      { chunks: [Buffer.alloc(65536, 1)] },
    ]) { const f = fixture(plan); await expect(f.service.request(args, f.value)).rejects.toMatchObject({ code: "resource-limit" }); expect(f.requests[0]!.response.destroyed).toBe(true); }
  });
  it("accepts the exact raw limit and decodes split multibyte characters once complete", async () => {
    const limit = fixture({ chunks: [Buffer.alloc(65536, 65)] }); expect(JSON.parse(await limit.service.request(args, limit.value)).body.length).toBe(65536);
    const bytes = Buffer.from("🌌黑塔"), split = fixture({ chunks: [bytes.subarray(0, 1), bytes.subarray(1, 4), bytes.subarray(4)] });
    expect(JSON.parse(await split.service.request(args, split.value)).body).toBe("🌌黑塔");
  });
  it("starts its absolute deadline before DNS and ignores a late resolver answer", async () => {
    fakeClock(); const dns = deferred<readonly { address: string; family: 4 }[]>(), f = fixture({}, async () => dns.promise);
    const result = f.service.request(args, f.value).catch(error => error); await flush(); await vi.advanceTimersByTimeAsync(PLUGIN_NETWORK_LIMITS.timeoutMs);
    expect(await result).toMatchObject({ code: "timeout" }); expect(f.resolving.mock.calls[0]![1].aborted).toBe(true);
    dns.resolve([{ address: "8.8.8.8", family: 4 }]); await flush(); expect(f.send).not.toHaveBeenCalled();
  });
  it("does not extend the absolute deadline when response data keeps arriving", async () => {
    fakeClock(); const f = fixture({ hold: true }), result = f.service.request(args, f.value).catch(error => error); await flush();
    await vi.advanceTimersByTimeAsync(14000); f.requests[0]!.response.emit("data", Buffer.from("still streaming"));
    await vi.advanceTimersByTimeAsync(1000); expect(await result).toMatchObject({ code: "timeout" }); expect(f.requests[0]!.destroyed).toBe(true);
  });
  it("disconnects active transfers on caller cancellation, policy revocation and disposal", async () => {
    fakeClock();
    for (const reason of ["cancel", "revoke", "dispose"] as const) {
      const f = fixture({ hold: true }), result = f.service.request(args, f.value).catch(error => error); await flush();
      if (reason === "cancel") f.controller.abort(); else if (reason === "dispose") f.service.dispose(); else { f.revoke(); await vi.advanceTimersByTimeAsync(100); }
      expect(await result).toMatchObject({ code: reason === "revoke" ? "revoked" : "cancelled" });
      expect(f.requests[0]!.destroyed).toBe(true); expect(f.requests[0]!.response.destroyed).toBe(true);
    }
  });
  it("limits DNS-plus-transport concurrency to four and disposes all owned lookups", async () => {
    const pending = deferred<readonly { address: string; family: 4 }[]>(), f = fixture({}, async () => pending.promise);
    const results = Array.from({ length: 4 }, () => f.service.request(args, f.value).catch(error => error));
    await expect(f.service.request(args, f.value)).rejects.toMatchObject({ code: "busy" }); expect(f.resolving).toHaveBeenCalledTimes(4);
    f.service.dispose(); expect((await Promise.all(results)).every(error => error.code === "cancelled")).toBe(true);
    expect(f.resolving.mock.calls.every(call => call[1].aborted)).toBe(true); pending.resolve([{ address: "8.8.8.8", family: 4 }]); await flush();
    expect(f.send).not.toHaveBeenCalled(); await expect(f.service.request(args, f.value)).rejects.toMatchObject({ code: "revoked" });
  });
  it("rejects incomplete streams and hides transport/TLS details without retrying", async () => {
    for (const plan of [{ incomplete: true, chunks: [Buffer.from("partial private response")] }, { error: "TLS failed for private path and token" }]) {
      const f = fixture(plan); await expect(f.service.request(args, f.value)).rejects.toMatchObject({ code: "host-error", message: "host-error" }); expect(f.send).toHaveBeenCalledTimes(1);
    }
  });

  it("R141 diagnostics classify non-public DNS without broadening the Guest error payload", async () => {
    const f = fixture({}, async () => [{ address: "198.18.0.22", family: 4 }]);
    const error = await f.service.request(args, f.value).catch(error => error);
    expect(error).toBeInstanceOf(PluginNetworkFault);
    expect(error).toMatchObject({ code: "capability-denied", reason: "non-public-address", message: "capability-denied" });
    const diagnostic = pluginNetworkDiagnostic(error)!;
    expect(diagnostic).toContain("可能"); expect(diagnostic).toContain("假 IP"); expect(diagnostic).toContain("不能据此确认");
    expect(diagnostic).not.toMatch(/198\.18|example\.com|resource|q=one/); expect(f.send).not.toHaveBeenCalled();
    const manifest = parseExecutablePluginManifest(JSON.stringify({ schemaVersion: 2, apiVersion: 1, id: "example.network", name: "Network fixture",
      version: "1.0.0", description: "Synthetic only", entry: "main.js",
      capabilities: [{ name: "network.request", origins: ["https://example.com"], methods: ["GET"] }],
      actions: [{ id: "fetch", title: "Fetch", scope: "chat", export: "fetch", inputs: [], capabilities: ["network.request"] }] }));
    const diagnostics: string[] = [], broker = new PluginCapabilityBroker({ manifest, binding: f.value.binding,
      current: () => ({ ...f.value.binding, enabled: true, permissionMode: "workspace-edit", planActive: false, grantedCapabilities: manifest.capabilities }),
      handlers: { "network.request": async (input, ctx) => {
        try { return await f.service.request(input, ctx); } catch (error) { const text = pluginNetworkDiagnostic(error); if (text) diagnostics.push(text); throw error; }
      } } });
    try {
      expect(await broker.call("network.request", JSON.stringify(args))).toEqual({ ok: false, code: "capability-denied" });
      expect(diagnostics).toEqual([diagnostic]);
    } finally { broker.dispose(); }
  });

  it("R141 diagnostics distinguish DNS TLS and connection errors without using raw details", async () => {
    const raw = "https://secret.example/token=private 10.0.0.1 certificate-private response-private";
    const cases = [
      { reason: "dns", f: fixture({}, async () => { throw Object.assign(Error(raw), { code: "ENOTFOUND" }); }) },
      { reason: "tls", f: fixture({ error: raw, errorCode: "ERR_TLS_CERT_ALTNAME_INVALID" }) },
      { reason: "connection", f: fixture({ error: raw, errorCode: "ECONNREFUSED" }) },
    ];
    for (const { reason, f } of cases) {
      const error = await f.service.request(args, f.value).catch(error => error);
      expect(error).toMatchObject({ reason, code: "host-error", message: "host-error" });
      expect(pluginNetworkDiagnostic(error)).toBeTruthy();
      expect(pluginNetworkDiagnostic(error)).not.toMatch(/secret|token|10\.0\.0\.1|certificate-private|response-private/);
      expect(f.send).toHaveBeenCalledTimes(reason === "dns" ? 0 : 1);
    }
    expect(pluginNetworkDiagnostic(Error(raw))).toBeUndefined();
  });

  it("R141 diagnostics retain distinct redirect compression encoding and response-limit reasons", async () => {
    const cases: { plan: Plan; reason: string; code: string }[] = [
      { plan: { status: 302, headers: { location: "https://secret.example/token=private", "set-cookie": ["private-cookie"] } }, reason: "redirect", code: "capability-denied" },
      { plan: { headers: { "content-type": "text/plain", "content-encoding": "gzip" } }, reason: "compression", code: "host-error" },
      { plan: { chunks: [Buffer.from([0xff, 0xfe])] }, reason: "encoding", code: "host-error" },
      { plan: { headers: { "content-type": "text/plain", "content-length": "65537" } }, reason: "response-limit", code: "resource-limit" },
    ];
    for (const { plan, reason, code } of cases) {
      const f = fixture(plan), error = await f.service.request(args, f.value).catch(error => error);
      expect(error).toMatchObject({ reason, code, message: code }); expect(pluginNetworkDiagnostic(error)).toBeTruthy();
      expect(pluginNetworkDiagnostic(error)).not.toMatch(/secret|token|private-cookie/);
      expect(f.requests[0]!.destroyed).toBe(true); expect(f.send).toHaveBeenCalledTimes(1);
    }
  });

  it("R141 diagnostics preserve cancellation revocation and timeout as separate terminal outcomes", async () => {
    fakeClock();
    for (const reason of ["cancelled", "revoked", "timeout"] as const) {
      const f = fixture({ hold: true }), pending = f.service.request(args, f.value).catch(error => error); await flush();
      if (reason === "cancelled") f.controller.abort();
      else if (reason === "revoked") { f.revoke(); await vi.advanceTimersByTimeAsync(PLUGIN_NETWORK_LIMITS.revocationPollMs); }
      else await vi.advanceTimersByTimeAsync(PLUGIN_NETWORK_LIMITS.timeoutMs);
      const error = await pending; expect(error).toMatchObject({ reason, code: reason, message: reason });
      expect(pluginNetworkDiagnostic(error)).toBeTruthy(); expect(pluginNetworkDiagnostic(error)).not.toMatch(/synthetic|private|失败/);
      expect(f.requests[0]!.destroyed).toBe(true); expect(f.requests[0]!.response.destroyed).toBe(true);
    }
  });
});
