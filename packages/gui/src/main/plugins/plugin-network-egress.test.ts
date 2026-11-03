import { EventEmitter } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { checkServerIdentity, type ConnectionOptions, type TLSSocket } from "node:tls";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_NETWORK_DEFAULT_CONFIG, type PluginNetworkConfig } from "../../shared/plugin-network-settings.js";
import { createPluginNetworkEgress, encodePluginDnsQuery, parsePluginDnsAnswer, type PluginNetworkEgressOptions } from "./plugin-network-egress.js";
import { createPluginNetworkService, pluginNetworkDiagnostic } from "./plugin-network-service.js";
import type { PluginCapabilityContext } from "./capability-broker.js";

const config = (proxyUrl = ""): PluginNetworkConfig => ({ ...PLUGIN_NETWORK_DEFAULT_CONFIG, ...(proxyUrl ? { mode: "proxy", proxyUrl } : {}) });
const doh: PluginNetworkConfig = { ...config(), resolver: "doh", dohUrl: "https://resolver.example/dns-query", dohBootstrapAddress: "8.8.8.8" };
const target = { hostname: "target.example", address: { address: "1.1.1.1", family: 4 as const }, port: 443 };
const servers = new Set<Server>(), connections = new Set<Socket>(), services = new Set<ReturnType<typeof createPluginNetworkService>>();
async function proxy(onRequest: (socket: Socket, wire: string) => void) {
  const server = createServer(socket => {
    connections.add(socket); socket.once("close", () => connections.delete(socket)); let wire = "";
    socket.on("data", (chunk: Buffer) => { wire += chunk.toString("latin1"); if (wire.includes("\r\n\r\n")) { socket.removeAllListeners("data"); onRequest(socket, wire); } });
    socket.on("error", () => {});
  }); servers.add(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("fixture address");
  return "http://127.0.0.1:" + address.port;
}
function context() {
  const abort = new AbortController();
  const value: PluginCapabilityContext = { signal: abort.signal, assertCurrent() {}, binding: { pluginId: "test.egress", actionId: "fetch", contentHash: "a".repeat(64),
    grantRevision: 1, sessionId: "synthetic", sessionRevision: 1, permissionRevision: 1, scope: "chat" } };
  return { abort, value };
}
function fakeTls() {
  const sockets: TLSSocket[] = [];
  const tls = vi.fn((options: ConnectionOptions) => {
    const socket = Object.assign(new PassThrough(), { authorized: true }) as unknown as TLSSocket; sockets.push(socket);
    if (options.socket) socket.once("close", () => options.socket!.destroy());
    queueMicrotask(() => socket.emit("secureConnect")); return socket;
  });
  return { tls, sockets };
}
function record(name: Buffer, type: number, data: Buffer) {
  const info = Buffer.alloc(10); info.writeUInt16BE(type, 0); info.writeUInt16BE(1, 2); info.writeUInt32BE(60, 4); info.writeUInt16BE(data.length, 8);
  return Buffer.concat([name, info, data]);
}
function dnsName(name: string) { return Buffer.concat([...name.split(".").map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]); }
function answer(query: Buffer, records: readonly Buffer[], rcode = 0) {
  const header = Buffer.from(query.subarray(0, 12)); header.writeUInt16BE(0x8180 | rcode, 2); header.writeUInt16BE(records.length, 6);
  return Buffer.concat([header, query.subarray(12), ...records]);
}
const owner = Buffer.from([0xc0, 0x0c]), ipv4 = Buffer.from([1, 1, 1, 1]);
class Response extends EventEmitter {
  complete = false; destroyed = false; statusCode = 200;
  headers: Record<string, string> = { "content-type": "application/dns-message" };
  destroy() { this.destroyed = true; return this; }
}
function wireRequest(build: (query: Buffer, response: Response) => Buffer) {
  const calls: { options: RequestOptions; body?: Buffer }[] = [];
  const request: NonNullable<PluginNetworkEgressOptions["request"]> = (options, receive) => {
    const call: (typeof calls)[number] = { options }; calls.push(call);
    const response = new Response(), emitter = new EventEmitter() as EventEmitter & { destroyed: boolean; destroy(): typeof emitter; end(body: Buffer): typeof emitter };
    emitter.destroyed = false; emitter.destroy = () => { emitter.destroyed = true; response.destroy(); return emitter; };
    emitter.end = (body: Buffer) => {
      call.body = Buffer.from(body);
      queueMicrotask(() => {
        if (emitter.destroyed) return; const bytes = build(body, response); receive(response as unknown as IncomingMessage);
        if (response.destroyed) return; response.emit("data", bytes); response.complete = true; response.emit("end");
      });
      return emitter;
    };
    return emitter as unknown as ClientRequest;
  };
  return { calls, request };
}
afterEach(async () => {
  for (const service of services) service.dispose(); services.clear();
  for (const socket of connections) socket.destroy();
  await Promise.all([...servers].map(server => new Promise<void>(resolve => server.close(() => resolve())))); servers.clear();
  vi.restoreAllMocks();
});

describe("R147 explicit plugin proxy and encrypted DNS", () => {
  it("parses matching A/AAAA and CNAME wire answers, rejects private/mixed, mismatched, truncated and looping answers", () => {
    const a = encodePluginDnsQuery("target.example", 1), aaaa = encodePluginDnsQuery("target.example", 28);
    expect(a.subarray(0, 6)).toEqual(Buffer.from([0, 0, 1, 0, 0, 1]));
    expect(parsePluginDnsAnswer(answer(a, [record(owner, 1, ipv4)]), "target.example", 1)).toEqual([{ address: "1.1.1.1", family: 4 }]);
    const v6 = Buffer.from("26064700470000000000000000001111", "hex");
    expect(parsePluginDnsAnswer(answer(aaaa, [record(owner, 28, v6)]), "target.example", 28)[0]?.family).toBe(6);
    expect(parsePluginDnsAnswer(answer(a, [record(owner, 5, dnsName("alias.example")), record(dnsName("alias.example"), 1, ipv4)]), "target.example", 1)).toHaveLength(1);
    expect(parsePluginDnsAnswer(answer(aaaa, [], 3), "target.example", 28)).toEqual([]);
    expect(() => parsePluginDnsAnswer(answer(a, [record(owner, 1, ipv4), record(owner, 1, Buffer.from([127, 0, 0, 1]))]), "target.example", 1)).toThrow(expect.objectContaining({ reason: "non-public-address" }));
    expect(() => parsePluginDnsAnswer(answer(a, []), "other.example", 1)).toThrow();
    const truncated = answer(a, []); truncated.writeUInt16BE(0x8380, 2);
    expect(() => parsePluginDnsAnswer(truncated, "target.example", 1)).toThrow();
    const loop = answer(a, []); loop[12] = 0xc0; loop[13] = 0x0c;
    expect(() => parsePluginDnsAnswer(loop, "target.example", 1)).toThrow();
    for (const ttl of [0x01000000, 0x00010000]) {
      const ordinary = answer(a, [record(owner, 1, ipv4)]); ordinary.writeUInt16BE(1, 10);
      const opt = record(Buffer.from([0]), 41, Buffer.alloc(0)); opt.writeUInt32BE(ttl, 5);
      expect(() => parsePluginDnsAnswer(Buffer.concat([ordinary, opt]), "target.example", 1)).toThrow();
    }
  });

  it("sends only numeric CONNECT and validates TLS against the original target; private target never reaches proxy", async () => {
    let captured = ""; const endpoint = await proxy((socket, wire) => { captured = wire; socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); });
    const fake = fakeTls(), egress = createPluginNetworkEgress({ tls: fake.tls }), abort = new AbortController();
    const socket = await egress.connectPinned(target, config(endpoint), abort.signal);
    expect(captured).toBe("CONNECT 1.1.1.1:443 HTTP/1.1\r\nHost: 1.1.1.1:443\r\n\r\n");
    const tls = fake.tls.mock.calls[0]![0];
    expect(tls).toMatchObject({ servername: "target.example", rejectUnauthorized: true, minVersion: "TLSv1.2", ALPNProtocols: ["http/1.1"] });
    const certificate = { subject: { CN: "other.example" }, subjectaltname: "DNS:other.example" } as Parameters<typeof checkServerIdentity>[1];
    expect(tls.checkServerIdentity?.("proxy.example", certificate)).toBeInstanceOf(Error);
    expect(tls).not.toHaveProperty("ca"); expect(tls).not.toHaveProperty("session");
    await expect(egress.connectPinned({ ...target, address: { address: "127.0.0.1", family: 4 } }, config(endpoint), abort.signal)).rejects.toMatchObject({ reason: "non-public-address" });
    abort.abort(); expect(socket.destroyed).toBe(true); await vi.waitFor(() => expect(connections.size).toBe(0));
  });

  it("fails on proxy refusal and invalid target TLS without direct fallback, and checks HTTPS proxy IP identity", async () => {
    const refused = await proxy(socket => socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n"));
    const fake = fakeTls(), egress = createPluginNetworkEgress({ tls: fake.tls });
    await expect(egress.connectPinned(target, config(refused), new AbortController().signal)).rejects.toMatchObject({ reason: "proxy-refused" });
    expect(fake.tls).not.toHaveBeenCalled();
    const oversized = await proxy(socket => socket.end("HTTP/1.1 200 OK\r\nX-Large: " + "a".repeat(8192) + "\r\n\r\n"));
    await expect(egress.connectPinned(target, config(oversized), new AbortController().signal)).rejects.toMatchObject({ reason: "proxy-format" });
    expect(fake.tls).not.toHaveBeenCalled();
    const invalidTls = await proxy(socket => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); socket.once("data", () => socket.end("not TLS")); socket.resume(); });
    await expect(createPluginNetworkEgress().connectPinned(target, config(invalidTls), AbortSignal.timeout(2000))).rejects.toMatchObject({ reason: "tls" });
    const secure = fakeTls();
    // Synthetic encrypted-proxy socket emits its CONNECT response only after the write.
    secure.tls.mockImplementation(options => {
      const socket = Object.assign(new PassThrough(), { authorized: true }) as unknown as TLSSocket;
      const write = socket.write.bind(socket);
      if (!options.socket) socket.write = ((chunk: Buffer | string) => { queueMicrotask(() => socket.emit("data", Buffer.from("HTTP/1.1 200 OK\r\n\r\n"))); return true; }) as typeof write;
      queueMicrotask(() => socket.emit("secureConnect")); return socket;
    });
    const abort = new AbortController(), socket = await createPluginNetworkEgress({ tls: secure.tls }).connectPinned(target, config("https://127.0.0.1:8443"), abort.signal);
    expect(secure.tls.mock.calls[0]![0]).toMatchObject({ host: "127.0.0.1", port: 8443, servername: "", rejectUnauthorized: true });
    expect(secure.tls.mock.calls[1]![0]).toMatchObject({ servername: "target.example", rejectUnauthorized: true });
    abort.abort(); expect(socket.destroyed).toBe(true);
  });

  it("uses bounded RFC8484 POST queries to the public bootstrap with resolver TLS identity and no auth, cookies, compression or fallback", async () => {
    const fake = fakeTls(), wire = wireRequest(query => {
      const type = query.readUInt16BE(query.length - 4); return type === 1 ? answer(query, [record(owner, 1, ipv4)]) : answer(query, [], 3);
    });
    const egress = createPluginNetworkEgress({ tls: fake.tls, request: wire.request });
    expect(await egress.resolveDoh("target.example", doh, new AbortController().signal)).toEqual([{ address: "1.1.1.1", family: 4 }]);
    expect(fake.tls).toHaveBeenCalledTimes(2);
    for (const call of fake.tls.mock.calls) expect(call[0]).toMatchObject({ host: "8.8.8.8", port: 443, servername: "resolver.example", rejectUnauthorized: true });
    for (const call of wire.calls) {
      expect(call.options).toMatchObject({ hostname: "resolver.example", path: "/dns-query", method: "POST", maxHeaderSize: 8192,
        headers: { Accept: "application/dns-message", "Content-Type": "application/dns-message", "Accept-Encoding": "identity" } });
      expect(Object.keys(call.options.headers!)).toEqual(["Accept", "Content-Type", "Content-Length", "Accept-Encoding"]);
      expect(call.body?.readUInt16BE(0)).toBe(0); expect(call.options.auth).toBeUndefined();
    }
    expect(fake.sockets.every(socket => socket.destroyed)).toBe(true);
    const bad = wireRequest((query, response) => { response.statusCode = 302; response.headers.location = "https://127.0.0.1/"; return answer(query, []); });
    await expect(createPluginNetworkEgress({ tls: fake.tls, request: bad.request }).resolveDoh("target.example", doh, new AbortController().signal)).rejects.toMatchObject({ reason: "doh-response" });
    expect(bad.calls).toHaveLength(2);
  });

  it("cancels owned pending CONNECT sockets on policy revision changes and caller cancellation before target HTTP is sent", async () => {
    for (const change of ["revision", "abort"] as const) {
      let requested = false; const endpoint = await proxy(() => { requested = true; });
      let revision = 1; const c = context(), send = vi.fn(() => { throw Error("target request must not start"); });
      const service = createPluginNetworkService({ getEgressPolicy: () => ({ revision, config: config(endpoint) }),
        resolve: async () => [target.address], request: send }); services.add(service);
      const pending = service.request({ url: "https://target.example/", method: "GET" }, c.value).catch(error => error);
      await vi.waitFor(() => expect(requested).toBe(true));
      if (change === "revision") revision++; else c.abort.abort();
      expect(await pending).toMatchObject({ reason: change === "revision" ? "policy-changed" : "cancelled" });
      expect(send).not.toHaveBeenCalled(); await vi.waitFor(() => expect(connections.size).toBe(0));
    }
  });

  it("fails closed on damaged policy or non-public DoH bootstrap before resolver/transport and emits only fixed diagnostics", async () => {
    const resolve = vi.fn(async () => [target.address]), request = vi.fn(() => { throw Error("must not connect"); }), c = context();
    for (const state of [{ revision: 1, config: config(), loadError: "private raw value must not escape" },
      { revision: 2, config: { ...doh, dohBootstrapAddress: "127.0.0.1" } }]) {
      const service = createPluginNetworkService({ getEgressPolicy: () => state, resolve, request }); services.add(service);
      const error = await service.request({ url: "https://target.example/", method: "GET" }, c.value).catch(value => value);
      expect(error).toMatchObject({ reason: "invalid-policy", code: "capability-denied" });
      expect(pluginNetworkDiagnostic(error)).not.toContain("private raw"); expect(pluginNetworkDiagnostic(error)).toContain("未自动改用其他出口");
    }
    expect(resolve).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
});

