export interface PluginNetworkConfig {
  readonly mode: "direct" | "proxy";
  readonly proxyUrl: string;
  readonly resolver: "system" | "doh";
  readonly dohUrl: string;
  readonly dohBootstrapAddress: string;
}
export interface PluginNetworkSettingsSnapshot {
  readonly revision: number;
  readonly config: PluginNetworkConfig;
  /** A display default is not an active policy while this field is present. */
  readonly loadError?: string;
}
export type PluginNetworkSettingsRequest = { kind: "network-settings-get" }
  | { kind: "network-settings-set"; expectedRevision: number; config: PluginNetworkConfig };
export type PluginNetworkSettingsReply = { ok: true; networkSettings: PluginNetworkSettingsSnapshot } | { ok: false; message: string };
export const PLUGIN_NETWORK_DEFAULT_CONFIG: PluginNetworkConfig = Object.freeze({ mode: "direct", proxyUrl: "", resolver: "system", dohUrl: "", dohBootstrapAddress: "" });
export class PluginNetworkConfigFault extends Error {
  constructor() { super("请检查插件联网设置：代理使用数字 IP 地址，可信解析使用 HTTPS 地址和公网引导 IP，均不能包含凭据。"); this.name = "PluginNetworkConfigFault"; }
}
const invalid = (): never => { throw new PluginNetworkConfigFault(); };
function clean(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return invalid();
  return value;
}
function numericAddress(value: string): string {
  if (/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value) && value.split(".").every(part => Number(part) <= 255)) return value;
  if (!value.includes(":") || !/^[0-9a-fA-F:.]+$/.test(value)) return invalid();
  try { const url = new URL(`https://[${value}]/`); return url.hostname.slice(1, -1).toLowerCase(); } catch { return invalid(); }
}
function endpoint(value: string, proxy: boolean): string {
  if (!value || /[?#@]/.test(value)) return invalid();
  let url: URL; try { url = new URL(value); } catch { return invalid(); }
  if ((proxy ? !["http:", "https:"].includes(url.protocol) : url.protocol !== "https:") || url.username || url.password || url.hash || url.search) return invalid();
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return invalid();
  if (proxy) {
    if (url.pathname !== "/") return invalid();
    numericAddress(url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname);
    return url.origin;
  }
  return url.href;
}
/** Pure renderer-friendly validation; the host additionally rejects a non-public
 * DoH bootstrap. No system proxy, credentials or provider configuration is read. */
export function parsePluginNetworkConfig(raw: unknown): PluginNetworkConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(raw), names = ["mode", "proxyUrl", "resolver", "dohUrl", "dohBootstrapAddress"];
  if (Reflect.ownKeys(raw).length !== names.length || names.some(key => !descriptors[key] || !("value" in descriptors[key]!))) return invalid();
  const value = Object.fromEntries(names.map(key => [key, descriptors[key]!.value]));
  if ((value.mode !== "direct" && value.mode !== "proxy") || (value.resolver !== "system" && value.resolver !== "doh")) return invalid();
  const proxy = clean(value.proxyUrl), doh = clean(value.dohUrl), bootstrap = clean(value.dohBootstrapAddress);
  if (value.mode === "proxy" && !proxy || value.resolver === "doh" && (!doh || !bootstrap)) return invalid();
  return Object.freeze({ mode: value.mode, proxyUrl: proxy ? endpoint(proxy, true) : "", resolver: value.resolver,
    dohUrl: doh ? endpoint(doh, false) : "", dohBootstrapAddress: bootstrap ? numericAddress(bootstrap) : "" });
}
