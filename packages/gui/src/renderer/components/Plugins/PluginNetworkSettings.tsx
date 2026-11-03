import { useEffect, useId, useRef, useState } from "react";
import type { PluginNetworkConfig, PluginNetworkSettingsSnapshot } from "../../../shared/plugin-network-settings.js";
import type { HertaBridge } from "../../ipc/bridge-types.js";

const copy = (config: PluginNetworkConfig): PluginNetworkConfig => ({ ...config });
function effective(config: PluginNetworkConfig): PluginNetworkConfig {
  return { mode: config.mode, proxyUrl: config.mode === "proxy" ? config.proxyUrl.trim() : "", resolver: config.resolver,
    dohUrl: config.resolver === "doh" ? config.dohUrl.trim() : "", dohBootstrapAddress: config.resolver === "doh" ? config.dohBootstrapAddress.trim() : "" };
}

/** Explicit configuration only. Reading or editing never probes a network endpoint. */
export function PluginNetworkSettings({ request, disabled = false }: {
  request: NonNullable<HertaBridge["executablePlugins"]>; disabled?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<PluginNetworkSettingsSnapshot>(), [draft, setDraft] = useState<PluginNetworkConfig>();
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const generation = useRef(0), lock = useRef(false), alive = useRef(false);
  const summary = useRef<HTMLElement>(null);
  const proxyHint = useId();

  async function load() {
    if (lock.current) return;
    const token = ++generation.current; lock.current = true; setLoading(true); setError(""); setNotice("");
    try {
      const reply = await request({ kind: "network-settings-get" });
      if (!alive.current || token !== generation.current) return;
      if (!reply.ok) { setError(reply.message); return; }
      if (!reply.networkSettings) { setError("未能取得插件联网设置，请重新读取。"); return; }
      setSnapshot(reply.networkSettings); setDraft(copy(reply.networkSettings.config));
    } catch { if (alive.current && token === generation.current) setError("暂时无法读取插件联网设置，已有配置未改动。"); }
    finally { if (alive.current && token === generation.current) { lock.current = false; setLoading(false); } }
  }
  useEffect(() => {
    alive.current = true; lock.current = false; setSnapshot(undefined); setDraft(undefined); setSaving(false); void load();
    return () => { alive.current = false; generation.current++; };
  }, [request]);

  async function save() {
    if (lock.current || disabled || !snapshot || !draft) return;
    const token = ++generation.current, expectedRevision = snapshot.revision, config = effective(draft);
    lock.current = true; setSaving(true); setError(""); setNotice("");
    try {
      const reply = await request({ kind: "network-settings-set", expectedRevision, config });
      if (!alive.current || token !== generation.current) return;
      // A conflict never adopts a new revision under the user's unchanged draft.
      // They must explicitly reload/discard before retrying against newer state.
      if (!reply.ok) { setError(reply.message); return; }
      if (!reply.networkSettings) { setError("未取得保存结果，请重新读取并核对，不会自动重试。"); return; }
      setSnapshot(reply.networkSettings); setDraft(copy(reply.networkSettings.config)); setNotice("插件联网设置已保存。");
    } catch { if (alive.current && token === generation.current) setError("未确认保存结果，输入仍保留。请重新读取并核对，不会自动重试。"); }
    finally { if (alive.current && token === generation.current) { lock.current = false; setSaving(false); } }
  }
  function change(patch: Partial<PluginNetworkConfig>) {
    if (!draft || lock.current || disabled) return;
    setDraft({ ...draft, ...patch }); setNotice("");
  }
  function cancel() {
    if (lock.current || !snapshot) return;
    setDraft(copy(snapshot.config)); setError(""); setNotice(""); setOpen(false); summary.current?.focus({ preventScroll: true });
  }
  const blocked = disabled || loading || saving;
  const dirty = !!snapshot && !!draft && JSON.stringify(effective(draft)) !== JSON.stringify(effective(snapshot.config));
  const problems = [snapshot?.loadError, error].filter((value, index, all): value is string => !!value && all.indexOf(value) === index).join(" ");
  return <section className="plugin-network-settings" aria-label="插件联网设置" aria-busy={loading || saving}>
    <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary ref={summary}><span>插件联网</span><small>{snapshot?.loadError ? "配置待处理" : snapshot ? `${snapshot.config.mode === "proxy" ? "指定代理" : "直连"} · ${snapshot.config.resolver === "doh" ? "自定义解析" : "系统解析"}` : loading ? "正在读取…" : "未取得设置"}</small></summary>
      <p className="executable-plugin-muted">只用于插件；保存后停止在途请求。不更改系统代理或 DNS。</p>
      {snapshot && draft && <fieldset disabled={blocked}>
        <label>连接方式<select value={draft.mode} onChange={event => change({ mode: event.target.value as PluginNetworkConfig["mode"] })}>
          <option value="direct">直连</option><option value="proxy">指定 HTTP(S) CONNECT 代理</option>
        </select></label>
        {draft.mode === "proxy" && <div><label>代理地址（数字 IP）<input type="text" inputMode="url" aria-describedby={proxyHint} autoComplete="off" spellCheck={false} maxLength={2048} value={draft.proxyUrl}
          placeholder="http://127.0.0.1:7890" onChange={event => change({ proxyUrl: event.target.value })} />
          </label><small id={proxyHint}>仅支持数字 IP 地址，不包含账号或密码。</small></div>}
        <label>域名解析<select value={draft.resolver} onChange={event => change({ resolver: event.target.value as PluginNetworkConfig["resolver"] })}>
          <option value="system">系统解析</option><option value="doh">自定义 HTTPS 解析（DoH）</option>
        </select></label>
        {draft.resolver === "doh" && <div className="plugin-network-resolver">
          <p className="executable-plugin-muted">所请求的域名会发送给你指定的解析服务。请使用可信服务，并填写它的公网 IP。</p>
          <label>HTTPS 解析地址<input type="text" inputMode="url" autoComplete="off" spellCheck={false} maxLength={2048} placeholder="https://resolver.example/dns-query"
            value={draft.dohUrl} onChange={event => change({ dohUrl: event.target.value })} /></label>
          <label>解析服务的公网 IP<input type="text" autoComplete="off" spellCheck={false} maxLength={64} placeholder="填写该解析服务的实际公网 IP"
            value={draft.dohBootstrapAddress} onChange={event => change({ dohBootstrapAddress: event.target.value })} /></label>
        </div>}
        <div className="executable-plugin-buttons"><button type="button" disabled={blocked || !dirty && !snapshot.loadError} onClick={() => void save()}>{saving ? "正在保存…" : "保存插件联网设置"}</button>
          <button type="button" disabled={blocked} onClick={cancel}>取消</button></div>
      </fieldset>}
    </details>
    {problems && <div className="plugin-network-problem"><p role="alert" className="executable-plugin-error">{problems}</p>
      <button type="button" disabled={blocked} onClick={() => void load()}>{draft ? "重新读取并放弃编辑" : "重新读取插件联网设置"}</button></div>}
    {notice && <p role="status" className="executable-plugin-muted">{notice}</p>}
  </section>;
}
