/** Actual isolated desktop helper; local deterministic service is never an API pass. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const [action, arg, extra] = process.argv.slice(2);
const port = process.env.HERTA_VERIFICATION_CDP_PORT ?? "9345";
if (!["9345", "9346"].includes(port))
  throw new Error("Verification CDP port must be 9345 or 9346");
const evidence = resolve("docs/reports/evidence/round-4");
mkdirSync(evidence, { recursive: true });
const protocols = [
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
];
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find((p) => p.type === "page" && p.url.startsWith("file:"));
if (!page) throw new Error("No packaged file renderer on verification port");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((done, reject) => {
  ws.addEventListener("open", done, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let serial = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  const task = pending.get(message.id);
  if (task) {
    clearTimeout(task.timer);
    pending.delete(message.id);
    message.error
      ? task.reject(new Error("CDP command rejected"))
      : task.done(message.result);
  }
});
function call(method, params = {}) {
  return new Promise((done, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Verification command timed out"));
    }, 300000);
    pending.set(id, { done, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function safe(value) {
  if (
    typeof value === "string" &&
    /sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+|-----BEGIN .*PRIVATE KEY/i.test(value)
  )
    throw new Error("Secret-like result blocked");
  if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (
        /^(api.?key|credential(?:ref)?|secret|authorization|x-api-key)$/i.test(
          key,
        )
      )
        throw new Error("Sensitive result field blocked");
      safe(item);
    }
  return value;
}
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error("Desktop evaluation rejected (raw diagnostic suppressed)");
  return safe(result.result.value);
}
const invoke = (method, input) =>
  evaluate(
    `window.herta.${method}(${input === undefined ? "" : JSON.stringify(input)})`,
  );
const label = (value) => {
  if (!/^[a-z0-9-]+$/.test(value ?? ""))
    throw new Error("Invalid evidence label");
  return value;
};
try {
  let result;
  if (action === "evaluate") {
    if (!isAbsolute(arg))
      throw new Error("Expected absolute isolated expression file");
    const expression = readFileSync(arg, "utf8");
    if (
      /sk-[A-Za-z0-9_-]{12,}|resolveProviderCredential|credentialRef/i.test(
        expression,
      )
    )
      throw new Error("Sensitive expression forbidden");
    result = await evaluate(expression);
  } else if (action === "summary") {
    result = await evaluate(
      "(async()=>{const v=await window.herta.getProviderSettings();return {version:await window.herta.getAppVersion(),runtimeActive:v.runtimeActive,providers:v.settings.providers.map(p=>({id:p.id,name:p.name,protocol:p.protocol,baseURL:p.baseURL,revision:p.revision,authentication:p.authentication,models:p.models.map(m=>({id:m.id,validation:m.validation,tools:m.capabilities.tools}))})),bindings:v.settings.defaultBindings,sessions:await window.herta.listSessions()};})()",
    );
  } else if (action === "capture") {
    const name = label(arg);
    const snapshot = await evaluate(
      "({title:document.title,text:document.body.innerText,width:innerWidth,height:innerHeight,scale:devicePixelRatio,require:typeof window.require,nodeProcess:typeof window.process,overflow:document.documentElement.scrollWidth>innerWidth})",
    );
    const shot = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(
      resolve(evidence, `${name}.png`),
      Buffer.from(shot.data, "base64"),
    );
    writeFileSync(
      resolve(evidence, `${name}.json`),
      JSON.stringify(snapshot, null, 2),
    );
    result = { captured: name, ...snapshot };
  } else if (action === "configure-fixture") {
    if (arg && !protocols.includes(arg))
      throw new Error("Invalid fixture protocol");
    const chosen = arg ? [arg] : protocols;
    result = await evaluate(
      `(async()=>{const out=[];for(const protocol of ${JSON.stringify(chosen)}){const v=await window.herta.getProviderSettings();const name='R4 deterministic local '+protocol;const existing=v.settings.providers.find(p=>p.name===name);const saved=await window.herta.saveProvider({...(existing?{id:existing.id,expectedRevision:existing.revision}:{}),name,protocol,baseURL:'http://127.0.0.1:9344/normal/prefix/v1',authentication:'none',allowRemoteHTTP:false,models:[{id:'r4-fixture'}],defaults:{model:'r4-fixture',timeoutMs:30000},credential:{action:'clear'}});const p=saved.settings.providers.find(p=>p.name===name);out.push({id:p.id,protocol:p.protocol,revision:p.revision});}return {deterministicFixture:true,providers:out};})()`,
    );
  } else if (["discover", "text", "tools", "bind"].includes(action)) {
    if (!protocols.includes(arg)) throw new Error("Invalid fixture protocol");
    const p = await evaluate(
      `(async()=>{const v=await window.herta.getProviderSettings();const p=v.settings.providers.find(p=>p.name==='R4 deterministic local '+${JSON.stringify(arg)});if(!p||p.authentication!=='none'||p.baseURL!=='http://127.0.0.1:9344/normal/prefix/v1')throw new Error('Expected authorized local fixture');return {id:p.id,revision:p.revision};})()`,
    );
    if (action === "bind") {
      await invoke("setProviderBindings", {
        bindings: {
          persona: { providerId: p.id, modelId: "r4-fixture" },
          executor: { providerId: p.id, modelId: "r4-fixture" },
        },
      });
      result = { deterministicFixture: true, bound: arg };
    } else {
      const input = {
        providerId: p.id,
        expectedRevision: p.revision,
        ...(action === "discover"
          ? { refresh: true }
          : { modelId: "r4-fixture", kind: action }),
      };
      // Select only the safe probe result; the full view contains opaque credential references.
      result = await evaluate(
        `(async()=>{const r=await window.herta.${action === "discover" ? "discoverProviderModels" : "validateProviderModel"}(${JSON.stringify(input)});return {deterministicFixture:true,protocol:${JSON.stringify(arg)},...(r.validation?{validation:r.validation}:{models:r.models,diagnostic:r.diagnostic})};})()`,
      );
    }
  } else if (action === "create") {
    if (!isAbsolute(arg))
      throw new Error("Expected absolute isolated project path");
    mkdirSync(arg, { recursive: true });
    const input = {
      workspaceRoot: arg,
      backendWorkspace: arg,
      lang: "zh",
    };
    result = await evaluate(
      `(async()=>{const s=await window.herta.createSession(${JSON.stringify(input)});return {sessionId:s.sessionId,workspaceRoot:s.workspaceRoot,backendWorkspace:s.backendWorkspace,recordBlocks:s.record?.length??0,recordStart:s.recordStart??0,resumable:s.resumable??false};})()`,
    );
  } else if (action === "open")
    result = await evaluate(
      `(async()=>{const s=await window.herta.openSession(${JSON.stringify(arg)});return {sessionId:s.sessionId,workspaceRoot:s.workspaceRoot,backendWorkspace:s.backendWorkspace,recordBlocks:s.record?.length??0,recordStart:s.recordStart??0,resumable:s.resumable??false};})()`,
    );
  else if (action === "close") {
    await evaluate("setTimeout(()=>window.herta.windowClose(),100);true");
    result = { closeRequested: true };
  } else if (action === "submit") result = await invoke("submitText", arg);
  else if (action === "interrupt") result = await invoke("interrupt");
  else if (action === "recover") result = await invoke("continueInterrupted");
  else if (action === "watch")
    result = await evaluate(
      "(()=>{window.__r4Events=[];window.__r4Off?.forEach(f=>f());window.__r4Off=[window.herta.onOverlay(e=>window.__r4Events.push({channel:'overlay',event:e})),window.herta.onTurn(e=>window.__r4Events.push({channel:'turn',event:e})),window.herta.onRecord(e=>window.__r4Events.push({channel:'record',event:e}))];return {watching:true};})()",
    );
  else if (action === "events")
    result = await evaluate(
      "({deterministicFixture:true,events:window.__r4Events??[]})",
    );
  else throw new Error("Unknown verification action");
  safe(result);
  if (extra)
    writeFileSync(
      resolve(evidence, `${label(extra)}.json`),
      JSON.stringify(result, null, 2),
    );
  console.log(JSON.stringify(result));
} finally {
  ws.close();
}
