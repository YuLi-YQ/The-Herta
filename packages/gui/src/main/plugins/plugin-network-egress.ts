import { connect as netConnect, isIP, type NetConnectOpts, type Socket } from "node:net";
import { connect as tlsConnect, checkServerIdentity, type ConnectionOptions, type TLSSocket } from "node:tls";
import { Agent, request as httpsRequest, type RequestOptions, type AgentOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { parsePluginNetworkConfig, type PluginNetworkConfig } from "../../shared/plugin-network-settings.js";
import { isPublicPluginAddress, type PluginNetworkAddress } from "./plugin-network-address.js";

export const PLUGIN_EGRESS_LIMITS = Object.freeze({ headerBytes: 8192, dnsBytes: 65535, dnsRecords: 64, dnsAddresses: 16, dnsPointers: 16 });
export type PluginEgressReason = "invalid-policy" | "non-public-address" | "proxy-connection" | "proxy-tls" | "proxy-refused"
  | "proxy-format" | "doh-response" | "doh-format" | "doh-limit" | "tls" | "connection" | "cancelled";
export class PluginEgressFault extends Error {
  constructor(readonly reason: PluginEgressReason) { super(reason); this.name = "PluginEgressFault"; }
}
export interface PluginPinnedDestination {
  readonly hostname: string;
  readonly address: PluginNetworkAddress;
  readonly port: number;
}
export interface PluginNetworkEgressOptions {
  /** Host-only test seams. These functions, sockets and policies never cross Guest IPC. */
  readonly connect?: (options: NetConnectOpts) => Socket;
  readonly tls?: (options: ConnectionOptions) => TLSSocket;
  readonly request?: (options: RequestOptions, response: (message: IncomingMessage) => void) => ClientRequest;
}
const fail = (reason: PluginEgressReason): never => { throw new PluginEgressFault(reason); };
const unbracket = (hostname: string) => hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
function live(signal: AbortSignal): void { if (signal.aborted) fail("cancelled"); }
function policy(raw: PluginNetworkConfig): PluginNetworkConfig {
  try {
    const value = parsePluginNetworkConfig(raw);
    if (value.resolver === "doh" && !isPublicPluginAddress(value.dohBootstrapAddress)) fail("non-public-address");
    return value;
  } catch (error) { if (error instanceof PluginEgressFault) throw error; return fail("invalid-policy"); }
}
function destination(value: PluginPinnedDestination): void {
  if (!value || typeof value.hostname !== "string" || !value.hostname || value.hostname.length > 253 || /[\x00-\x20\\/#@]/.test(value.hostname)
    || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535) fail("invalid-policy");
  if (!value.address || ![4, 6].includes(value.address.family) || isIP(value.address.address) !== value.address.family
    || !isPublicPluginAddress(value.address.address)) fail("non-public-address");
}
function ownSocket<T extends Socket>(socket: T, signal: AbortSignal): T {
  const abort = () => socket.destroy();
  // The socket can error after the stage-specific listener has been removed and
  // before the HTTP parser takes ownership. Never expose an unhandled raw error.
  socket.on("error", () => {});
  signal.addEventListener("abort", abort, { once: true });
  socket.once("close", () => signal.removeEventListener("abort", abort));
  if (signal.aborted) socket.destroy();
  return socket;
}
function ready<T extends Socket>(socket: T, event: "connect" | "secureConnect", signal: AbortSignal, reason: PluginEgressReason): Promise<T> {
  return new Promise((resolve, reject) => {
    let ended = false;
    const finish = (ok: boolean) => {
      if (ended) return; ended = true; socket.off(event, success); socket.off("error", failure); socket.off("close", failure);
      if (ok && !signal.aborted) resolve(socket);
      else { socket.destroy(); reject(new PluginEgressFault(signal.aborted ? "cancelled" : reason)); }
    };
    const success = () => finish(event !== "secureConnect" || (socket as unknown as TLSSocket).authorized === true);
    const failure = () => finish(false);
    socket.once(event, success); socket.once("error", failure); socket.once("close", failure);
    if (signal.aborted || socket.destroyed) finish(false);
  });
}
/** Numeric CONNECT authority only; proxy-provided bodies/redirects are never read as target data. */
function tunnel(socket: Socket, authority: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0), ended = false;
    const finish = (reason?: PluginEgressReason) => {
      if (ended) return; ended = true; socket.off("data", data); socket.off("error", failed); socket.off("close", failed);
      if (reason || signal.aborted) { socket.destroy(); reject(new PluginEgressFault(signal.aborted ? "cancelled" : reason!)); }
      else { socket.pause(); resolve(); }
    };
    const failed = () => finish("proxy-connection");
    const data = (chunk: Buffer) => {
      if (!Buffer.isBuffer(chunk) || bytes.length + chunk.length > PLUGIN_EGRESS_LIMITS.headerBytes) return finish("proxy-format");
      bytes = Buffer.concat([bytes, chunk]); const end = bytes.indexOf("\r\n\r\n"); if (end < 0) return;
      if (end + 4 !== bytes.length) return finish("proxy-format");
      const header = bytes.subarray(0, end).toString("latin1"), lines = header.split("\r\n");
      const status = /^HTTP\/1\.[01] ([0-9]{3})(?: [\x20-\x7e]*)?$/.exec(lines.shift() ?? "");
      if (!status || lines.length > 64 || lines.some(line => !/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+:[\x09\x20-\x7e]*$/.test(line))) return finish("proxy-format");
      if (Number(status[1]) < 200 || Number(status[1]) >= 300) return finish("proxy-refused");
      if (lines.some(line => /^transfer-encoding:/i.test(line) || /^content-length:/i.test(line) && !/^content-length:\s*0\s*$/i.test(line))) return finish("proxy-format");
      finish();
    };
    socket.on("data", data); socket.once("error", failed); socket.once("close", failed);
    if (signal.aborted || socket.destroyed) return finish("cancelled");
    socket.write("CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\n\r\n");
  });
}
function hostname(value: string): string {
  const name = value.toLowerCase().replace(/\.$/, "");
  if (!name || name.length > 253 || !name.includes(".") || name.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) fail("doh-format");
  return name;
}
/** RFC 8484 POST wire message: ID=0, recursion desired, one IN A/AAAA question. */
export function encodePluginDnsQuery(name: string, type: 1 | 28): Buffer {
  if (type !== 1 && type !== 28) fail("doh-format");
  const labels = hostname(name).split(".").map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "ascii")]));
  const header = Buffer.alloc(12); header.writeUInt16BE(0x0100, 2); header.writeUInt16BE(1, 4);
  const question = Buffer.alloc(5); question.writeUInt16BE(type, 1); question.writeUInt16BE(1, 3);
  return Buffer.concat([header, ...labels, question]);
}
function nameAt(bytes: Buffer, start: number): { name: string; next: number } {
  let at = start, next: number | undefined, hops = 0, length = 0; const labels: string[] = [], visited = new Set<number>();
  while (true) {
    if (at >= bytes.length || visited.has(at)) fail("doh-format"); visited.add(at);
    const size = bytes[at++]!;
    if ((size & 0xc0) === 0xc0) {
      if (at >= bytes.length || ++hops > PLUGIN_EGRESS_LIMITS.dnsPointers) fail("doh-format");
      const pointer = ((size & 0x3f) << 8) | bytes[at++]!;
      if (pointer >= at - 2 || pointer < 12) fail("doh-format");
      next ??= at; at = pointer; continue;
    }
    if (size & 0xc0 || size > 63 || at + size > bytes.length) fail("doh-format");
    if (!size) return { name: labels.join(".").toLowerCase(), next: next ?? at };
    const label = bytes.subarray(at, at + size).toString("latin1");
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label) || (length += size + 1) > 254) fail("doh-format");
    labels.push(label); at += size;
  }
}
/** Bounded DNS decoder; only matching-question IN records on its CNAME chain
 * become destinations. Truncated/looped/mismatched/private answers fail closed. */
export function parsePluginDnsAnswer(bytes: Buffer, queriedName: string, queryType: 1 | 28): readonly PluginNetworkAddress[] {
  const expected = hostname(queriedName);
  if (queryType !== 1 && queryType !== 28) fail("doh-format");
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > PLUGIN_EGRESS_LIMITS.dnsBytes || bytes.readUInt16BE(0) !== 0) fail("doh-format");
  const flags = bytes.readUInt16BE(2), rcode = flags & 15;
  if (!(flags & 0x8000) || flags & 0x7800 || flags & 0x0200 || flags & 0x0040 || ![0, 3].includes(rcode)
    || bytes.readUInt16BE(4) !== 1) fail("doh-format");
  const counts = [bytes.readUInt16BE(6), bytes.readUInt16BE(8), bytes.readUInt16BE(10)];
  if (counts.reduce((a, b) => a + b, 0) > PLUGIN_EGRESS_LIMITS.dnsRecords) fail("doh-limit");
  const question = nameAt(bytes, 12); let at = question.next;
  if (question.name !== expected || at + 4 > bytes.length || bytes.readUInt16BE(at) !== queryType || bytes.readUInt16BE(at + 2) !== 1) fail("doh-format");
  at += 4;
  const aliases = new Map<string, string>(), addresses: { owner: string; address: PluginNetworkAddress }[] = []; let opt = false;
  for (let section = 0; section < 3; section++) for (let i = 0; i < counts[section]!; i++) {
    const owner = nameAt(bytes, at); at = owner.next;
    if (at + 10 > bytes.length) fail("doh-format");
    const type = bytes.readUInt16BE(at), klass = bytes.readUInt16BE(at + 2), ttl = bytes.readUInt32BE(at + 4), length = bytes.readUInt16BE(at + 8); at += 10;
    const end = at + length; if (end > bytes.length) fail("doh-format");
    // OPT carries extended RCODE and EDNS version in the high TTL bytes. An
    // unsupported/error extension must not be mistaken for ordinary NOERROR.
    if (type === 41) { if (section !== 2 || owner.name !== "" || opt || (ttl >>> 16) !== 0) fail("doh-format"); opt = true; }
    if (section === 0 && (type === 1 || type === 28 || type === 5)) {
      if (klass !== 1) fail("doh-format");
      if (type === 5) {
        const alias = nameAt(bytes, at); if (alias.next !== end || !alias.name || aliases.has(owner.name)) fail("doh-format");
        aliases.set(owner.name, alias.name);
      } else {
        if (type !== queryType || length !== (type === 1 ? 4 : 16)) fail("doh-format");
        const address = type === 1 ? [...bytes.subarray(at, end)].join(".")
          : Array.from({ length: 8 }, (_, index) => bytes.readUInt16BE(at + index * 2).toString(16)).join(":");
        if (!isPublicPluginAddress(address)) fail("non-public-address");
        addresses.push({ owner: owner.name, address: { address, family: type === 1 ? 4 : 6 } });
        if (addresses.length > PLUGIN_EGRESS_LIMITS.dnsAddresses) fail("doh-limit");
      }
    }
    at = end;
  }
  if (at !== bytes.length || rcode === 3 && addresses.length) fail("doh-format");
  const chain = new Set<string>(); let current = expected;
  while (true) {
    if (chain.has(current) || chain.size >= 16) fail("doh-format"); chain.add(current);
    const next = aliases.get(current); if (next === undefined) break; current = next;
  }
  if ([...aliases.keys()].some(owner => !chain.has(owner)) || addresses.some(item => item.owner !== current)) fail("doh-format");
  return Object.freeze(addresses.map(item => Object.freeze(item.address)));
}

/** No environment proxy, shared Electron session, credentials, redirect, retry or
 * remote destination DNS. Every tunnel names a previously checked public IP. */
export function createPluginNetworkEgress(options: PluginNetworkEgressOptions = {}) {
  const connect = options.connect ?? netConnect, secure = options.tls ?? tlsConnect, send = options.request ?? httpsRequest;
  async function connectPinned(rawTarget: PluginPinnedDestination, rawPolicy: PluginNetworkConfig, signal: AbortSignal): Promise<TLSSocket> {
    destination(rawTarget); const config = policy(rawPolicy), target = { ...rawTarget, address: { ...rawTarget.address } }; live(signal);
    let underlying: Socket | undefined, encrypted: TLSSocket | undefined;
    try {
      if (config.mode === "proxy") {
        const proxy = new URL(config.proxyUrl), proxyHost = unbracket(proxy.hostname), port = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
        if (!isIP(proxyHost)) fail("invalid-policy");
        if (proxy.protocol === "https:") {
          underlying = ownSocket(secure({ host: proxyHost, port, servername: "", rejectUnauthorized: true, minVersion: "TLSv1.2",
            ALPNProtocols: ["http/1.1"], checkServerIdentity: (_host, cert) => checkServerIdentity(proxyHost, cert) }), signal);
          await ready(underlying, "secureConnect", signal, "proxy-tls");
        } else {
          underlying = ownSocket(connect({ host: proxyHost, port, family: isIP(proxyHost) as 4 | 6 }), signal);
          await ready(underlying, "connect", signal, "proxy-connection");
        }
        live(signal);
        await tunnel(underlying, (target.address.family === 6 ? "[" + target.address.address + "]" : target.address.address) + ":" + target.port, signal);
      }
      live(signal);
      encrypted = ownSocket(secure({ ...(underlying ? { socket: underlying } : { host: target.address.address, port: target.port, family: target.address.family }),
        servername: isIP(target.hostname) ? "" : target.hostname, rejectUnauthorized: true, minVersion: "TLSv1.2",
        ALPNProtocols: ["http/1.1"], checkServerIdentity: (_host, cert) => checkServerIdentity(target.hostname, cert) }), signal);
      await ready(encrypted, "secureConnect", signal, "tls"); live(signal); return encrypted;
    } catch (error) {
      encrypted?.destroy(); underlying?.destroy();
      if (signal.aborted) fail("cancelled");
      if (error instanceof PluginEgressFault) throw error;
      return fail(config.mode === "proxy" ? "proxy-connection" : "connection");
    }
  }
  async function queryDoh(name: string, type: 1 | 28, config: PluginNetworkConfig, signal: AbortSignal): Promise<readonly PluginNetworkAddress[]> {
    live(signal); const url = new URL(config.dohUrl), query = encodePluginDnsQuery(name, type);
    const socket = await connectPinned({ hostname: unbracket(url.hostname), port: Number(url.port || 443),
      address: { address: config.dohBootstrapAddress, family: isIP(config.dohBootstrapAddress) as 4 | 6 } }, config, signal);
    const agentOptions: AgentOptions & { proxyEnv: Record<string, string> } = { keepAlive: false, maxSockets: 1, maxTotalSockets: 1, maxCachedSessions: 0, proxyEnv: {} };
    const agent = new Agent(agentOptions); let used = false;
    agent.createConnection = () => { if (used || signal.aborted) fail("cancelled"); used = true; return socket; };
    return new Promise((resolve, reject) => {
      let request: ClientRequest | undefined, response: IncomingMessage | undefined, ended = false;
      const finish = (reason?: PluginEgressReason, value?: readonly PluginNetworkAddress[]) => {
        if (ended) return; ended = true; signal.removeEventListener("abort", abort);
        response?.destroy(); request?.destroy(); agent.destroy(); socket.destroy();
        if (reason) reject(new PluginEgressFault(reason)); else resolve(value!);
      };
      const abort = () => finish("cancelled"); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) return abort();
      try {
        request = send({ protocol: "https:", hostname: unbracket(url.hostname), port: Number(url.port || 443), path: url.pathname,
          method: "POST", headers: { Accept: "application/dns-message", "Content-Type": "application/dns-message", "Content-Length": query.length, "Accept-Encoding": "identity" },
          agent, maxHeaderSize: PLUGIN_EGRESS_LIMITS.headerBytes, signal }, incoming => {
          if (ended || response) { incoming.destroy(); if (!ended) finish("doh-response"); return; } response = incoming;
          let complete = false; const bytes = Buffer.alloc(PLUGIN_EGRESS_LIMITS.dnsBytes); let length = 0;
          incoming.once("error", () => finish("doh-response")); incoming.once("aborted", () => finish("doh-response"));
          incoming.once("close", () => { if (!complete) finish("doh-response"); });
          const encoding = incoming.headers["content-encoding"], mime = incoming.headers["content-type"], declared = incoming.headers["content-length"];
          if (!Number.isInteger(incoming.statusCode) || incoming.statusCode! < 200 || incoming.statusCode! >= 300
            || typeof mime !== "string" || mime.trim().toLowerCase() !== "application/dns-message"
            || encoding !== undefined && encoding !== "identity") return finish("doh-response");
          if (declared !== undefined && (typeof declared !== "string" || !/^\d+$/.test(declared) || Number(declared) > bytes.length)) return finish("doh-limit");
          incoming.on("data", (chunk: Buffer) => {
            if (ended) return;
            if (!Buffer.isBuffer(chunk) || length + chunk.length > bytes.length) return finish("doh-limit");
            chunk.copy(bytes, length); length += chunk.length;
          });
          incoming.once("end", () => {
            complete = true; if (ended) return;
            if (!incoming.complete) return finish("doh-response");
            try { finish(undefined, parsePluginDnsAnswer(bytes.subarray(0, length), name, type)); }
            catch (error) { finish(error instanceof PluginEgressFault ? error.reason : "doh-format"); }
          });
        });
        request.once("error", () => finish(signal.aborted ? "cancelled" : "doh-response"));
        request.once("upgrade", (_response, upgraded: Socket) => { upgraded.destroy(); finish("doh-response"); });
        request.once("connect", (_response, upgraded: Socket) => { upgraded.destroy(); finish("doh-response"); });
        request.end(query);
      } catch (error) { finish(error instanceof PluginEgressFault ? error.reason : "doh-response"); }
    });
  }
  return {
    connectPinned,
    async resolveDoh(name: string, rawPolicy: PluginNetworkConfig, signal: AbortSignal): Promise<readonly PluginNetworkAddress[]> {
      const config = policy(rawPolicy); if (config.resolver !== "doh") fail("invalid-policy");
      const lifetime = new AbortController(), linked = AbortSignal.any([signal, lifetime.signal]);
      try {
        const [a, aaaa] = await Promise.all([queryDoh(name, 1, config, linked), queryDoh(name, 28, config, linked)]);
        if (a.length + aaaa.length > PLUGIN_EGRESS_LIMITS.dnsAddresses) fail("doh-limit");
        return Object.freeze([...a, ...aaaa]);
      } finally { lifetime.abort(); }
    },
  };
}

