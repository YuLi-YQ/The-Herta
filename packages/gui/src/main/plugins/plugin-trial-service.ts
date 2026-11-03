import { createHash, randomUUID } from "node:crypto";
import { parseExecutablePluginPackage, type ExecutablePluginCapabilityName, type ExecutablePluginHttpMethod } from "../../shared/executable-plugins.js";
import { parsePluginJson, validatePluginActionInput, type PluginRunResult } from "../../shared/plugin-runtime.js";
import { parsePluginControlledView, type PluginControlledView, type PluginControlledViewDefinition } from "../../shared/plugin-view.js";
import type { PluginTrialFrozen, PluginTrialRequest, PluginTrialFixtures, PluginTrialResult, PluginTrialTrace } from "../../shared/plugin-trial.js";
import { PluginBrokerFault, PluginCapabilityBroker } from "./capability-broker.js";
import { executablePluginPackageHash, type PluginRuntimeService, type PluginTask } from "./plugin-runtime-service.js";

export const PLUGIN_TRIAL_LIMITS = Object.freeze({ fixturesBytes: 512 * 1024, retainedBytes: 1024 * 1024, files: 16, responses: 16, trace: 64 });
export interface PluginTrialGuard { readonly signal: AbortSignal; assertCurrent(): void }
export interface PluginTrialTask { readonly id: string; readonly result: Promise<PluginTrialResult>; readonly closed: Promise<void>; cancel(): void }
export class PluginTrialFault extends Error {
  constructor(readonly reason: "candidate" | "input" | "busy" | "revoked") {
    super(({ candidate: "待检插件内容或版本不匹配，请重新检查。", input: "试跑参数或模拟样本不符合要求。",
      busy: "已有试跑未结束，请等待或停止后再试。", revoked: "待检版本或工坊状态已变化，请重新试跑。" } as const)[reason]);
    this.name = "PluginTrialFault";
  }
}
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const fail = (): never => { throw new PluginTrialFault("input"); };
const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) return fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || bytes(value) > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) return fail();
  return value;
}
function list(value: unknown, maximum: number): readonly unknown[] { if (!Array.isArray(value) || value.length > maximum) return fail(); return value; }
function filePath(value: unknown): string {
  const path = text(value, 1024);
  if (!path || path.split("/").some(part => !part || part === "." || part === ".." || /[\\:\r\n]/.test(part))) return fail();
  return path;
}
function urlText(value: unknown): string {
  const raw = text(value, 2048); if (/[\s\\#]/.test(raw)) return fail();
  let url: URL; try { url = new URL(raw); } catch { return fail(); }
  if (url.protocol !== "https:" || url.username || url.password || url.port === "0") return fail(); return url.href;
}
function fixturesFrom(json: string): PluginTrialFixtures {
  const raw = object(parsePluginJson(json, PLUGIN_TRIAL_LIMITS.fixturesBytes), ["workspace", "privateValues", "network", "commands"]);
  const workspace = raw.workspace === undefined ? [] : list(raw.workspace, 16).map(value => {
    const item = object(value, ["path", "text"]); return { path: filePath(item.path), text: text(item.text, 128 * 1024) };
  });
  if (new Set(workspace.map(file => file.path)).size !== workspace.length) return fail();
  const privateValues = raw.privateValues === undefined ? {} : raw.privateValues;
  if (!privateValues || typeof privateValues !== "object" || Array.isArray(privateValues) || Object.keys(privateValues).length > 100
    || Object.keys(privateValues).some(key => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(key)) || bytes(JSON.stringify(privateValues)) > 256 * 1024) return fail();
  const network = raw.network === undefined ? [] : list(raw.network, 16).map(value => {
    const item = object(value, ["url", "method", "body", "response"]), response = object(item.response, ["status", "contentType", "body"]);
    if (typeof item.method !== "string" || !methods.has(item.method) || !Number.isInteger(response.status) || (response.status as number) < 200 || (response.status as number) > 599) return fail();
    const body = item.body === undefined ? undefined : text(item.body, 65536);
    if ((item.method === "GET" || item.method === "HEAD") && body !== undefined) return fail();
    return { url: urlText(item.url), method: item.method as ExecutablePluginHttpMethod, ...(body !== undefined ? { body } : {}),
      response: { status: response.status as number, contentType: text(response.contentType, 160), body: text(response.body, 65536) } };
  });
  const commands = raw.commands === undefined ? [] : list(raw.commands, 16).map(value => {
    const item = object(value, ["argv", "cwd", "result"]), result = object(item.result, ["exitCode", "stdout", "stderr"]);
    const argv = list(item.argv, 64).map(arg => text(arg, 2048));
    if (!argv.length || !argv[0] || !Number.isInteger(result.exitCode) || Math.abs(result.exitCode as number) > 2147483647) return fail();
    const cwd = item.cwd === undefined || item.cwd === "." ? undefined : filePath(item.cwd);
    return { argv, ...(cwd ? { cwd } : {}), result: { exitCode: result.exitCode as number, stdout: text(result.stdout, 24576), stderr: text(result.stderr, 24576) } };
  });
  if (new Set(network.map(item => JSON.stringify([item.url, item.method, item.body]))).size !== network.length
    || new Set(commands.map(item => JSON.stringify([item.argv, item.cwd ?? "."]))).size !== commands.length) return fail();
  return { workspace, privateValues: privateValues as NonNullable<PluginTrialFixtures["privateValues"]>, network, commands };
}

/** Runs uninstalled frozen JS against memory fixtures only. No fs, real network,
 * command adapter, provider, installed store or real owner is accepted here. */
export function createPluginTrialService(options: { runtime: Pick<PluginRuntimeService, "start"> }) {
  const active = new Set<PluginTrialTask>(); let disposed = false;
  return {
    start(frozen: PluginTrialFrozen, request: PluginTrialRequest, guard: PluginTrialGuard): PluginTrialTask {
      if (disposed || guard.signal.aborted) throw new PluginTrialFault("revoked");
      try { guard.assertCurrent(); } catch { throw new PluginTrialFault("revoked"); }
      if (active.size) throw new PluginTrialFault("busy");
      let pkg: ReturnType<typeof parseExecutablePluginPackage>;
      try {
        if (!frozen || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(frozen.candidateId) || !Number.isSafeInteger(frozen.revision) || frozen.revision < 0
          || typeof frozen.packageJson !== "string" || bytes(frozen.packageJson) > 2 * 1024 * 1024 || hash(frozen.packageJson) !== frozen.sourceHash) throw Error();
        pkg = parseExecutablePluginPackage(frozen.packageJson); if (executablePluginPackageHash(pkg) !== frozen.contentHash) throw Error();
      } catch { throw new PluginTrialFault("candidate"); }
      const source = Object.freeze({ candidateId: frozen.candidateId, revision: frozen.revision, sourceHash: frozen.sourceHash, contentHash: frozen.contentHash });
      if (!request || typeof request !== "object" || Array.isArray(request)
        || Object.keys(request).some(key => !["actionId", "scope", "inputJson", "fixturesJson"].includes(key))) return fail();
      const action = pkg.manifest.actions.find(item => item.id === request.actionId);
      if (!action || (request.scope !== "chat" && request.scope !== "workbench") || (action.scope !== "both" && action.scope !== request.scope)) return fail();
      let inputJson: string, fixtures: PluginTrialFixtures;
      try { inputJson = validatePluginActionInput(action, request.inputJson); fixtures = fixturesFrom(request.fixturesJson ?? "{}"); }
      catch { return fail(); }
      const id = randomUUID(), startedAt = new Date().toISOString(), scope = request.scope;
      const requestHash = hash(JSON.stringify({ ...source, actionId: action.id, scope, inputJson, fixtures }));
      const controller = new AbortController(), onAbort = () => controller.abort(); guard.signal.addEventListener("abort", onAbort, { once: true });
      let held = bytes(JSON.stringify(fixtures));
      const charge = (value: unknown) => {
        const size = bytes(JSON.stringify(value));
        if (held + size > PLUGIN_TRIAL_LIMITS.retainedBytes) throw new PluginBrokerFault("resource-limit"); held += size;
      };
      const workspace = new Map((fixtures.workspace ?? []).map(file => [file.path, file.text]));
      const privateValues = new Map(Object.entries(fixtures.privateValues ?? {}));
      const trace: PluginTrialTrace[] = [], unverified: { capability: ExecutablePluginCapabilityName; reason: string }[] = [];
      const logs: { level: "info" | "warn" | "error"; message: string }[] = [];
      const artifacts: PluginTrialResult["artifacts"][number][] = [], proposals: PluginTrialResult["proposals"][number][] = [];
      let draftProposal: string | undefined, controlledView: PluginControlledView | undefined, progress: PluginTrialResult["progress"];
      const missingFixture = (capability: ExecutablePluginCapabilityName): never => {
        if (!unverified.some(item => item.capability === capability)) unverified.push({ capability, reason: "没有匹配的明确模拟样本；未访问真实环境。" });
        throw new PluginBrokerFault("capability-denied");
      };
      const definition = (view: PluginControlledViewDefinition) => {
        try {
        const parsed = parsePluginControlledView(JSON.stringify(view));
        const actions = parsed.actions.map(button => {
          const target = pkg.manifest.actions.find(item => item.id === button.actionId);
          if (!target || target.scope !== "both" && target.scope !== scope) throw new PluginBrokerFault("invalid-input");
          return { ...button, inputJson: validatePluginActionInput(target, button.inputJson) };
        });
        return parsePluginControlledView(JSON.stringify({ ...parsed, actions }));
        } catch { throw new PluginBrokerFault("invalid-input"); }
      };
      const binding = { pluginId: pkg.manifest.id, contentHash: source.contentHash, actionId: action.id, grantRevision: 0,
        sessionId: "trial:" + id, sessionRevision: source.revision, permissionRevision: 0, scope };
      const broker = new PluginCapabilityBroker({ manifest: pkg.manifest, binding, signal: controller.signal,
        current: () => {
          if (disposed || controller.signal.aborted || guard.signal.aborted) return null;
          try { guard.assertCurrent(); } catch { return null; }
          return { ...binding, enabled: true, permissionMode: "workspace-edit", planActive: false, grantedCapabilities: pkg.manifest.capabilities };
        },
        observe: event => {
          if (event.phase === "requested") { if (trace.length < 64) trace.push({ requestId: event.requestId, capability: event.capability, state: "requested", simulated: true }); }
          else { const index = trace.findIndex(item => item.requestId === event.requestId); if (index >= 0) trace[index] = { requestId: event.requestId, capability: event.capability,
            state: event.code ? "rejected" : "completed", ...(event.code ? { code: event.code } : {}), simulated: true }; }
        }, handlers: {
          "workspace.readText": args => {
            const raw = workspace.get(args.path); if (raw === undefined) return missingFixture("workspace.readText");
            if (bytes(raw) > (args.maxBytes ?? 65536)) throw new PluginBrokerFault("resource-limit");
            return JSON.stringify({ text: raw.startsWith("\uFEFF") ? raw.slice(1) : raw, bytes: bytes(raw), sha256: hash(raw) });
          },
          "workspace.proposePatch": args => {
            const before = workspace.get(args.path) ?? null, baseHash = before === null ? null : hash(before);
            if (baseHash !== args.baseHash) throw new PluginBrokerFault("invalid-input");
            const after = before?.startsWith("\uFEFF") && !args.content.startsWith("\uFEFF") ? "\uFEFF" + args.content : args.content;
            const proposal = { id: randomUUID(), path: args.path, before, after, baseHash, nextHash: hash(after), status: "pending" as const };
            charge(proposal); proposals.push(proposal);
            return JSON.stringify({ proposalId: proposal.id, path: proposal.path, baseHash, nextHash: proposal.nextHash, status: "pending" });
          },
          "storage.get": args => JSON.stringify(privateValues.get(args.key) ?? null),
          "storage.set": args => {
            const value = parsePluginJson(JSON.stringify(args.value), 65536), next = Object.fromEntries(privateValues); next[args.key] = value;
            if (Object.keys(next).length > 100 || bytes(JSON.stringify(next)) > 256 * 1024) throw new PluginBrokerFault("resource-limit");
            parsePluginJson(JSON.stringify(next), 256 * 1024); charge(value); privateValues.set(args.key, value); return "null";
          },
          "artifacts.create": args => {
            const artifact = { id: randomUUID(), name: args.name, mime: args.mime, text: args.text, bytes: bytes(args.text), sha256: hash(args.text) };
            charge(artifact); artifacts.push(artifact); return JSON.stringify({ artifactId: artifact.id, name: artifact.name, mime: artifact.mime, bytes: artifact.bytes, sha256: artifact.sha256, saved: true });
          },
          "commands.run": args => {
            const fixture = fixtures.commands?.find(item => JSON.stringify(item.argv) === JSON.stringify(args.argv) && (item.cwd ?? ".") === (args.cwd ?? "."));
            if (!fixture) return missingFixture("commands.run");
            const value = { ...fixture.result, signal: null, timedOut: false, durationMs: 0, stdoutBytes: bytes(fixture.result.stdout), stderrBytes: bytes(fixture.result.stderr), stdoutTruncated: false, stderrTruncated: false };
            charge(value); return JSON.stringify(value);
          },
          "network.request": args => {
            const fixture = fixtures.network?.find(item => item.url === args.url && item.method === args.method && item.body === args.body);
            if (!fixture) return missingFixture("network.request");
            const value = { ...fixture.response, ok: fixture.response.status >= 200 && fixture.response.status < 300 };
            charge(value); return JSON.stringify(value);
          },
          "draft.append": args => { const next = draftProposal ? draftProposal + "\n\n" + args.text : args.text;
            if (next.length > 32000) throw new PluginBrokerFault("resource-limit"); charge(args.text); draftProposal = next; return '{"staged":true}'; },
          "ui.present": args => {
            if (controlledView) throw new PluginBrokerFault("invalid-input");
            const next = { ...definition(args.view), id: randomUUID(), revision: 1 }; charge(next); controlledView = next;
            return JSON.stringify({ viewId: next.id, revision: next.revision });
          },
          "ui.update": args => {
            if (!controlledView || controlledView.id !== args.viewId || controlledView.revision !== args.revision) throw new PluginBrokerFault("invalid-input");
            const next = { ...definition(args.view), id: controlledView.id, revision: controlledView.revision + 1 }; charge(next); controlledView = next;
            return JSON.stringify({ viewId: next.id, revision: next.revision });
          },
          log: args => { charge(args); logs.push(args); return "null"; },
          progress: args => { charge(args); progress = args; return "null"; },
        } });
      let runtimeTask: PluginTask;
      try { runtimeTask = options.runtime.start({ packageJson: JSON.stringify(pkg), actionId: action.id, inputJson }, broker); }
      catch { broker.dispose(); guard.signal.removeEventListener("abort", onAbort); throw new PluginTrialFault("revoked"); }
      const result = runtimeTask.result.catch((): PluginRunResult => ({ ok: false, code: "host-error" })).then(runtimeResult => {
        if (runtimeResult.ok) {
          try { if (controller.signal.aborted || guard.signal.aborted) throw Error(); guard.assertCurrent(); }
          catch { runtimeResult = { ok: false, code: "revoked" }; }
        }
        broker.dispose(); guard.signal.removeEventListener("abort", onAbort);
        const outcome = !runtimeResult.ok && (runtimeResult.code === "cancelled" || runtimeResult.code === "revoked") ? "cancelled"
          : unverified.length ? "unverified" : runtimeResult.ok ? "completed" : "failed";
        return Object.freeze({ id, ...source, requestHash, actionId: action.id, scope, simulated: true as const, externalEnvironmentVerified: false as const,
          startedAt, endedAt: new Date().toISOString(), outcome, runtimeResult, trace: Object.freeze([...trace]), unverified: Object.freeze([...unverified]),
          logs: Object.freeze([...logs]), ...(progress ? { progress } : {}), ...(draftProposal ? { draftProposal } : {}), artifacts: Object.freeze([...artifacts]),
          proposals: Object.freeze([...proposals]), ...(controlledView ? { controlledView } : {}), retainedBytes: held });
      });
      const task: PluginTrialTask = { id, result, closed: runtimeTask.closed, cancel() { runtimeTask.cancel(); controller.abort(); } };
      active.add(task); void task.closed.then(() => active.delete(task)); return task;
    },
    dispose() { disposed = true; for (const task of active) task.cancel(); },
  };
}
