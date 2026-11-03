import { Resolver } from "node:dns/promises";
import { isPublicPluginAddress, type PluginNetworkAddress as Address } from "./plugin-network-address.js";
export { isPublicPluginAddress } from "./plugin-network-address.js";
import { Agent, request as httpsRequest, type RequestOptions, type AgentOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { isIP, type LookupFunction } from "node:net";
import { performance } from "node:perf_hooks";
import { checkServerIdentity } from "node:tls";
import { parsePluginNetworkConfig, PLUGIN_NETWORK_DEFAULT_CONFIG, type PluginNetworkConfig } from "../../shared/plugin-network-settings.js";
import { createPluginNetworkEgress, PluginEgressFault } from "./plugin-network-egress.js";
import { PLUGIN_RUNTIME_LIMITS, type PluginRuntimeFaultCode } from "../../shared/plugin-runtime.js";
import { PluginBrokerFault, type PluginCapabilityArguments, type PluginCapabilityContext } from "./capability-broker.js";

export const PLUGIN_NETWORK_LIMITS = Object.freeze({ responseBytes: 65536, bodyBytes: 65536, headerBytes: 8192,
  dnsAnswers: 16, concurrent: 4, timeoutMs: 15000, revocationPollMs: 100 });

const NETWORK_FAILURES = Object.freeze({
  "invalid-request": { code: "invalid-input", message: "联网请求格式不符合要求，未发起连接。" },
  "non-public-address": { code: "capability-denied", message: "目标地址未通过公网地址检查。若使用代理，也可能与假 IP 解析有关；目前不能据此确认原因。" },
  dns: { code: "host-error", message: "域名解析未成功，尚未建立目标连接。" },
  "dns-limit": { code: "resource-limit", message: "域名解析返回的地址数量超过本地限制，未发起连接。" },
  "invalid-policy": { code: "capability-denied", message: "插件联网设置无法完整读取或不符合要求；未自动改用其他出口，请检查设置。" },
  "policy-changed": { code: "revoked", message: "插件联网设置已变化，本次请求已停止；没有自动改用新出口或重试。" },
  "proxy-connection": { code: "host-error", message: "未能连接明确配置的代理；没有绕过代理直连或自动重试。" },
  "proxy-tls": { code: "host-error", message: "明确配置的 HTTPS 代理未通过 TLS 校验；没有忽略证书校验。" },
  "proxy-refused": { code: "capability-denied", message: "明确配置的代理拒绝建立连接；没有附加认证信息或改为直连。" },
  "proxy-format": { code: "host-error", message: "代理返回的连接响应不符合受限协议，已关闭连接。" },
  "doh-response": { code: "host-error", message: "明确配置的加密解析服务未返回可用响应；没有回退到其他解析方式。" },
  "doh-format": { code: "host-error", message: "加密解析的回答不完整或与请求不匹配，未连接目标。" },
  "doh-limit": { code: "resource-limit", message: "加密解析的回答超过本地限制，未连接目标。" },
  tls: { code: "host-error", message: "TLS 连接或证书校验未通过；未忽略校验，也未自动重试。" },
  connection: { code: "host-error", message: "连接未完成或传输中断，本次没有自动重试。" },
  redirect: { code: "capability-denied", message: "收到 3xx 响应；当前不跟随重定向。" },
  compression: { code: "host-error", message: "响应采用了压缩编码；当前只读取未压缩文本。" },
  "content-type": { code: "host-error", message: "响应类型不受支持；当前只读取文本、JSON 或 XML。" },
  encoding: { code: "host-error", message: "响应不是当前支持的 UTF-8 文本，内容未交给插件。" },
  "request-limit": { code: "resource-limit", message: "请求正文超过本地发送限制，未发起连接。" },
  "response-limit": { code: "resource-limit", message: "响应超过本地读取限制，已停止接收；没有返回截断正文。" },
  "response-format": { code: "host-error", message: "服务返回的 HTTP 响应不完整或格式不受支持。" },
  "protocol-upgrade": { code: "capability-denied", message: "服务尝试升级协议或建立隧道，当前只允许普通 HTTPS 响应。" },
  timeout: { code: "timeout", message: "本次联网等待超时，已停止等待。" },
  cancelled: { code: "cancelled", message: "本次联网操作已取消。" },
  revoked: { code: "revoked", message: "会话、权限或插件状态已变化，本次联网已停止。" },
  busy: { code: "busy", message: "已有联网请求正在处理，请稍后再试。" },
} as const satisfies Record<string, { code: PluginRuntimeFaultCode; message: string }>);
export type PluginNetworkReason = keyof typeof NETWORK_FAILURES;
/** Host-only classification. The broker still forwards only the existing code,
 * never this reason, a raw exception, certificate, URL, address or response data. */
export class PluginNetworkFault extends PluginBrokerFault {
  constructor(readonly reason: PluginNetworkReason) { super(NETWORK_FAILURES[reason].code); this.name = "PluginNetworkFault"; }
}
export function pluginNetworkDiagnostic(error: unknown): string | undefined {
  return error instanceof PluginNetworkFault && Object.hasOwn(NETWORK_FAILURES, error.reason) ? NETWORK_FAILURES[error.reason].message : undefined;
}
function transportReason(error: unknown): PluginNetworkReason {
  // Code allowlists only: never infer from messages containing a URL, peer
  // certificate or response, and do not invoke arbitrary error-code getters.
  let code: unknown;
  try { if (error && typeof error === "object") code = Object.getOwnPropertyDescriptor(error, "code")?.value; } catch { /* No diagnostic data from an unfamiliar exception. */ }
  if (typeof code !== "string") return "connection";
  if (code === "HPE_HEADER_OVERFLOW") return "response-limit";
  if (code.length <= 80 && (/^ERR_(?:TLS|SSL)_/.test(code) || ["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_REVOKED", "INVALID_CA", "CERT_UNTRUSTED", "CERT_REJECTED"].includes(code))) return "tls";
  return "connection";
}
export interface PluginNetworkServiceOptions {
  /** Trusted host test seams only; never supplied by manifests, Guest code or renderer IPC. */
  readonly resolve?: (hostname: string, signal: AbortSignal) => Promise<readonly Address[]>;
  readonly request?: (options: RequestOptions, response: (message: IncomingMessage) => void) => ClientRequest;
  readonly getEgressPolicy?: () => { readonly revision: number; readonly config: PluginNetworkConfig; readonly loadError?: string };
  readonly egress?: ReturnType<typeof createPluginNetworkEgress>;
}
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const fault = (reason: PluginNetworkReason): never => { throw new PluginNetworkFault(reason); };
const validText = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);

function parseInput(args: PluginCapabilityArguments["network.request"]) {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => !["url", "method", "body"].includes(key))
    || !validText(args.url, 2048) || /[\u0000-\u0020\\#]/.test(args.url) || !METHODS.has(args.method)) fault("invalid-request");
  let url: URL; try { url = new URL(args.url); } catch { return fault("invalid-request"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) fault("invalid-request");
  const port = url.port ? Number(url.port) : 443;
  // Node may treat a falsy port as the HTTPS default. Never let a granted :0
  // origin silently connect to :443 instead.
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fault("invalid-request");
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const domain = hostname.toLowerCase().replace(/\.$/, "");
  if (!isIP(hostname) && (!domain.includes(".") || domain.length > 253 || domain.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || /(?:^|\.)(?:localhost|local|internal|localdomain|lan|onion|test|invalid)$/.test(domain) || domain.endsWith(".home.arpa"))) fault("non-public-address");
  if (isIP(hostname) && !isPublicPluginAddress(hostname)) fault("non-public-address");
  if (args.body !== undefined && (args.method === "GET" || args.method === "HEAD" || !validText(args.body, 48000))) fault("invalid-request");
  const body = args.body === undefined ? undefined : Buffer.from(args.body, "utf8");
  if (body && body.length > PLUGIN_NETWORK_LIMITS.bodyBytes) fault("request-limit");
  return { hostname, method: args.method, port, path: url.pathname + url.search, body };
}

/** Unlike dns.lookup(), these cancellable DNS queries do not use hosts-file or
 * other OS name-service aliases. Both record families must finish successfully
 * or report an explicit negative answer; a failed family is not silently ignored. */
async function resolveAddresses(hostname: string, signal: AbortSignal): Promise<readonly Address[]> {
  const resolver = new Resolver({ timeout: PLUGIN_NETWORK_LIMITS.timeoutMs, tries: 1 });
  const cancel = () => resolver.cancel(); signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) fault("cancelled");
    const answers = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    if (signal.aborted) fault("cancelled");
    const result: Address[] = [];
    for (let index = 0; index < answers.length; index++) {
      const answer = answers[index]!;
      if (answer.status === "rejected") {
        if (!["ENODATA", "ENOTFOUND"].includes(String((answer.reason as NodeJS.ErrnoException)?.code))) fault("dns");
      } else for (const address of answer.value) result.push({ address, family: index === 0 ? 4 : 6 });
    }
    return result;
  } finally { signal.removeEventListener("abort", cancel); resolver.cancel(); }
}
function contentType(message: IncomingMessage, noBody: boolean): string {
  const encoding = message.headers["content-encoding"];
  if (encoding !== undefined && (typeof encoding !== "string" || encoding.trim().toLowerCase() !== "identity")) fault("compression");
  const value = message.headers["content-type"];
  if (value === undefined && noBody) return "";
  if (typeof value !== "string" || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return fault("content-type");
  const mime = value.split(";", 1)[0]!.trim().toLowerCase();
  if (mime.length > 160 || !(/^(?:text\/[a-z0-9!#$&^_.+-]+|application\/(?:json|xml|[a-z0-9!#$&^_.+-]+\+(?:json|xml)))$/.test(mime))) {
    if (noBody) return ""; return fault("content-type");
  }
  for (const match of value.matchAll(/;\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]+))/gi)) {
    if (!["utf-8", "utf8", "us-ascii"].includes((match[1] ?? match[2] ?? "").toLowerCase())) fault("encoding");
  }
  return mime;
}

/** HTTPS only, no shared browser/provider session, no redirect/retry/decompression.
 * A private Agent excludes ambient proxies. An explicit host proxy receives only
 * the pinned public numeric destination, with original-host TLS inside the tunnel.
 * The broker continues to own origins, methods and workspace permission grants. */
export function createPluginNetworkService(options: PluginNetworkServiceOptions = {}) {
  const resolve = options.resolve ?? resolveAddresses, send = options.request ?? httpsRequest;
  const egress = options.egress ?? createPluginNetworkEgress();
  const readPolicy = () => {
    try {
      const value = options.getEgressPolicy?.() ?? { revision: 0, config: PLUGIN_NETWORK_DEFAULT_CONFIG };
      if (!Number.isSafeInteger(value.revision) || value.revision < 0 || value.loadError !== undefined) fault("invalid-policy");
      const config = parsePluginNetworkConfig(value.config);
      if (config.resolver === "doh" && !isPublicPluginAddress(config.dohBootstrapAddress)) fault("invalid-policy");
      return { revision: value.revision, config, signature: JSON.stringify(config) };
    } catch { return fault("invalid-policy"); }
  };
  const active = new Set<() => void>(); let disposed = false;
  return {
    async request(args: PluginCapabilityArguments["network.request"], context: PluginCapabilityContext): Promise<string> {
      if (disposed) fault("revoked");
      const input = parseInput(args); // Owned primitives/body snapshot before any await.
      const policy = readPolicy();
      if (active.size >= PLUGIN_NETWORK_LIMITS.concurrent) fault("busy");
      if (context.signal.aborted) fault("cancelled");
      try { context.assertCurrent(); } catch { return fault("revoked"); }
      return new Promise<string>((resolveResult, rejectResult) => {
        const abort = new AbortController(), deadline = performance.now() + PLUGIN_NETWORK_LIMITS.timeoutMs;
        let request: ClientRequest | undefined, response: IncomingMessage | undefined, agent: Agent | undefined, settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined;
        const finish = (reason?: PluginNetworkReason, result?: string) => {
          if (settled) return; settled = true;
          clearTimeout(timeout); clearInterval(poll); context.signal.removeEventListener("abort", cancelled); active.delete(cancelled);
          abort.abort();
          try { response?.destroy(); } catch { /* Owned stream only. */ }
          try { request?.destroy(); } catch { /* Owned request only. */ }
          try { agent?.destroy(); } catch { /* Never the global agent. */ }
          if (reason) rejectResult(new PluginNetworkFault(reason)); else resolveResult(result!);
        };
        const cancelled = () => finish("cancelled");
        const current = (): boolean => {
          if (settled) return false;
          if (performance.now() >= deadline) { finish("timeout"); return false; }
          if (disposed || context.signal.aborted || abort.signal.aborted) { finish("cancelled"); return false; }
          try { const latest = readPolicy(); if (latest.revision !== policy.revision || latest.signature !== policy.signature) { finish("policy-changed"); return false; } }
          catch { finish("policy-changed"); return false; }
          try { context.assertCurrent(); return true; } catch { finish("revoked"); return false; }
        };
        active.add(cancelled); context.signal.addEventListener("abort", cancelled, { once: true });
        timeout = setTimeout(() => finish("timeout"), PLUGIN_NETWORK_LIMITS.timeoutMs);
        poll = setInterval(current, PLUGIN_NETWORK_LIMITS.revocationPollMs); poll.unref?.();
        void (async () => {
          let stage: "dns" | "connection" = "dns";
          try {
            if (!current()) return;
            const family = isIP(input.hostname);
            const answers = family ? [{ address: input.hostname, family: family as 4 | 6 }]
              : policy.config.resolver === "doh" ? await egress.resolveDoh(input.hostname, policy.config, abort.signal) : await resolve(input.hostname, abort.signal);
            if (!current()) return;
            if (!Array.isArray(answers) || answers.length === 0) return finish("dns");
            if (answers.length > PLUGIN_NETWORK_LIMITS.dnsAnswers) return finish("dns-limit");
            if (answers.some(answer => !answer || (answer.family !== 4 && answer.family !== 6) || isIP(answer.address) !== answer.family || !isPublicPluginAddress(answer.address))) return finish("non-public-address");
            stage = "connection";
            const pinned = Object.freeze({ address: answers[0]!.address, family: answers[0]!.family });
            const lookup: LookupFunction = (hostname, options, callback) => {
              if (!current() || hostname !== input.hostname) return callback(Object.assign(new Error("network unavailable"), { code: "ECANCELED" }), "", pinned.family);
              callback(null, options.all ? [{ ...pinned }] : pinned.address, pinned.family);
            };
            // proxyEnv is supported in our Node 22.23/24 runtimes; the installed
            // Node 22 type declarations predate that additive Agent option.
            const agentOptions: AgentOptions & { proxyEnv: Record<string, string> } = { keepAlive: false, maxSockets: 1, maxTotalSockets: 1, maxCachedSessions: 0, proxyEnv: {} };
            agent = new Agent(agentOptions);
            if (policy.config.mode === "proxy") {
              const socket = await egress.connectPinned({ hostname: input.hostname, address: pinned, port: input.port }, policy.config, abort.signal);
              if (!current()) { socket.destroy(); return; }
              let used = false;
              agent.createConnection = () => { if (used || !current()) throw new PluginEgressFault("cancelled"); used = true; return socket; };
            }
            const headers: Record<string, string | number> = { "Accept-Encoding": "identity" };
            if (input.body !== undefined) { headers["Content-Type"] = "text/plain; charset=utf-8"; headers["Content-Length"] = input.body.length; }
            const requestOptions: RequestOptions & { autoSelectFamily: boolean } = { protocol: "https:", hostname: input.hostname, port: input.port, path: input.path,
              method: input.method, headers, lookup, family: pinned.family, autoSelectFamily: false, agent,
              servername: family ? "" : input.hostname, rejectUnauthorized: true, minVersion: "TLSv1.2", checkServerIdentity,
              maxHeaderSize: PLUGIN_NETWORK_LIMITS.headerBytes, signal: abort.signal };
            if (!current()) return;
            request = send(requestOptions, incoming => {
              if (settled) { incoming.destroy(); return; }
              if (response) { incoming.destroy(); finish("response-format"); return; } response = incoming;
              let ended = false;
              incoming.on("error", error => finish(transportReason(error))); incoming.once("aborted", () => finish("connection"));
              incoming.once("close", () => { if (!ended) finish("connection"); });
              try {
                if (!current()) return;
                const status = incoming.statusCode;
                if (!Number.isInteger(status) || status! < 200 || status! > 599) return finish("response-format");
                if (status! >= 300 && status! < 400) return finish("redirect");
                const noBody = input.method === "HEAD" || status === 204 || status === 205, mime = contentType(incoming, noBody);
                const declared = incoming.headers["content-length"];
                if (!noBody && declared !== undefined) {
                  if (typeof declared !== "string" || !/^\d+$/.test(declared)) return finish("response-format");
                  if (Number(declared) > PLUGIN_NETWORK_LIMITS.responseBytes) return finish("response-limit");
                }
                const bytes = Buffer.alloc(PLUGIN_NETWORK_LIMITS.responseBytes); let length = 0;
                incoming.on("data", (chunk: unknown) => {
                  if (!current()) return;
                  if (!Buffer.isBuffer(chunk) || (noBody && chunk.length !== 0)) return finish("response-format");
                  if (length + chunk.length > bytes.length) return finish("response-limit");
                  chunk.copy(bytes, length); length += chunk.length;
                });
                incoming.once("end", () => {
                  ended = true; if (!current()) return;
                  if (!incoming.complete) return finish("connection");
                  try {
                    const body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
                    if (body.includes("\0")) return finish("encoding");
                    const result = JSON.stringify({ status, ok: status! >= 200 && status! < 300, contentType: mime, body });
                    if (Buffer.byteLength(result, "utf8") > PLUGIN_RUNTIME_LIMITS.outputBytes) return finish("response-limit");
                    finish(undefined, result);
                  } catch { finish("encoding"); }
                });
              } catch (error) { finish(error instanceof PluginNetworkFault ? error.reason : "response-format"); }
            });
            request.on("error", error => finish(transportReason(error)));
            request.once("upgrade", (_incoming, socket) => { socket.destroy(); finish("protocol-upgrade"); });
            request.once("connect", (_incoming, socket) => { socket.destroy(); finish("protocol-upgrade"); });
            if (!current()) { request.destroy(); return; }
            request.end(input.body);
          } catch (error) { finish(error instanceof PluginNetworkFault || error instanceof PluginEgressFault ? error.reason : stage === "dns" ? "dns" : transportReason(error)); }
        })();
      });
    },
    dispose() { disposed = true; for (const cancel of [...active]) cancel(); },
  };
}
