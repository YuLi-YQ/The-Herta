/** Real Electron IPC helper. Never resolves or prints credentials. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [action, arg, model = "deepseek-flash"] = process.argv.slice(2);
const evidence = resolve("docs/reports/evidence/round-3");
mkdirSync(evidence, { recursive: true });
const pages = await (await fetch("http://127.0.0.1:9338/json/list")).json();
const ws = new WebSocket(
  pages.find((p) => p.type === "page").webSocketDebuggerUrl,
);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let serial = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const message = JSON.parse(String(e.data));
  const item = pending.get(message.id);
  if (item) {
    clearTimeout(item.timer);
    pending.delete(message.id);
    message.error
      ? item.reject(new Error("CDP command failed"))
      : item.resolve(message.result);
  }
});
function call(method, params = {}) {
  return new Promise((done, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Electron IPC timed out"));
    }, 300000);
    pending.set(id, { resolve: done, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description?.split("\n")[0] ||
        "Electron IPC rejected",
    );
  return result.result.value;
}
const invoke = (name, input) =>
  evaluate(
    `window.herta.${name}(${input === undefined ? "" : JSON.stringify(input)})`,
  );
try {
  let result;
  if (action === "summary") {
    result = await evaluate(
      `(async()=>{const v=await window.herta.getProviderSettings();return {runtimeActive:v.runtimeActive,providers:v.settings.providers.map(p=>({id:p.id,name:p.name,protocol:p.protocol,baseURL:p.baseURL,revision:p.revision,models:p.models.map(m=>({id:m.id,validation:m.validation,tools:m.capabilities.tools}))})),credentials:v.credentialStatuses,bindings:v.settings.defaultBindings,sessions:await window.herta.listSessions()};})()`,
    );
  } else if (action === "invalid-auth") {
    result = await evaluate(
      `(async()=>{let savedId;try{const v=await window.herta.saveProvider({name:'R3 temporary invalid-auth test',protocol:'openai-responses',baseURL:'https://api.deepseek.com',authentication:'api-key',allowRemoteHTTP:false,models:[{id:'deepseek-flash'}],defaults:{model:'deepseek-flash',timeoutMs:30000},credential:{action:'replace',value:'invalid-round-3-test'}});const p=v.settings.providers.find(p=>p.name==='R3 temporary invalid-auth test');savedId=p.id;const tested=await window.herta.validateProviderModel({providerId:p.id,expectedRevision:p.revision,modelId:'deepseek-flash',kind:'text'});return {realService:true,credentialKind:'deliberately-invalid-synthetic',validation:tested.validation};}finally{if(savedId)await window.herta.deleteProvider(savedId);}})()`,
    );
  } else if (action === "reroot-responses") {
    if (!["http://127.0.0.1:9340", "https://api.deepseek.com"].includes(arg))
      throw new Error("Unexpected test endpoint");
    result = await evaluate(
      `(async()=>{const v=await window.herta.getProviderSettings();const p=v.settings.providers.find(p=>p.protocol==='openai-responses');const saved=await window.herta.saveProvider({id:p.id,expectedRevision:p.revision,name:p.name,protocol:p.protocol,baseURL:${JSON.stringify(arg)},authentication:p.authentication,allowRemoteHTTP:false,models:p.models.map(m=>({id:m.id,...(m.alias?{alias:m.alias}:{})})),defaults:p.defaults,credential:{action:'keep'}});return {changedRoot:${JSON.stringify(arg)},credential:'kept-encrypted'};})()`,
    );
  } else if (action === "settings") {
    result = await evaluate(
      "document.querySelector('.herta-settings-button').click();true",
    );
  } else if (action === "history") {
    result = await evaluate(
      "(()=>{const s=[...document.querySelectorAll('summary')].find(s=>s.textContent==='最近项目');if(s)s.parentElement.open=true;return true;})()",
    );
  } else if (action === "close-settings") {
    result = await evaluate(
      "document.querySelector('.settings-close')?.click();true",
    );
  } else if (action === "latest") {
    result = await evaluate(
      "(()=>{const c=document.querySelector('.herta-content');c.scrollTop=c.scrollHeight;return true;})()",
    );
  } else if (action === "close") {
    await evaluate("setTimeout(()=>window.herta.windowClose(),100);true");
    result = { closeRequested: true };
  } else if (action === "capture") {
    const snapshot = await evaluate(
      "({title:document.title,text:document.body.innerText,width:innerWidth,height:innerHeight,scale:devicePixelRatio,require:typeof window.require,nodeProcess:typeof window.process,overflow:document.documentElement.scrollWidth>innerWidth})",
    );
    const shot = await call("Page.captureScreenshot", { format: "png" });
    if (!/^[a-z0-9-]+$/.test(arg)) throw new Error("Invalid evidence label");
    writeFileSync(
      resolve(evidence, `${arg}.png`),
      Buffer.from(shot.data, "base64"),
    );
    writeFileSync(
      resolve(evidence, `${arg}.json`),
      JSON.stringify(snapshot, null, 2),
    );
    result = { captured: arg, ...snapshot };
  } else if (action === "create") {
    const root = resolve(arg);
    mkdirSync(root, { recursive: true });
    result = await invoke("createSession", {
      workspaceRoot: root,
      backendWorkspace: root,
    });
  } else if (action === "open") result = await invoke("openSession", arg);
  else if (action === "recover") result = await invoke("continueInterrupted");
  else if (action === "file" || action === "diff") {
    const [id, ...path] = arg.split(",");
    result = await evaluate(
      `window.herta.${action === "file" ? "readWorkspaceFile" : "readWorkspaceDiff"}(${JSON.stringify(id)},${JSON.stringify(path.join(","))})`,
    );
  } else if (action === "rename") {
    const [id, ...title] = arg.split(",");
    result = await evaluate(
      `window.herta.renameSession(${JSON.stringify(id)},${JSON.stringify(title.join(","))})`,
    );
  } else if (action === "interrupt") result = await invoke("interrupt");
  else if (action === "discover" || action === "text" || action === "tools") {
    const p = await evaluate(
      `(async()=>{const v=await window.herta.getProviderSettings();return v.settings.providers.find(p=>p.protocol===${JSON.stringify(arg)});})()`,
    );
    if (!p) throw new Error("No configured provider for requested protocol");
    const tested = await invoke(
      action === "discover"
        ? "discoverProviderModels"
        : "validateProviderModel",
      {
        providerId: p.id,
        expectedRevision: p.revision,
        ...(action === "discover"
          ? { refresh: true }
          : { modelId: model, kind: action }),
      },
    );
    result =
      action === "discover"
        ? {
            protocol: p.protocol,
            models: tested.models,
            cached: tested.cached,
            diagnostic: tested.diagnostic,
          }
        : { protocol: p.protocol, model, validation: tested.validation };
    writeFileSync(
      resolve(evidence, `real-${p.protocol}-${action}.json`),
      JSON.stringify(result, null, 2),
    );
  } else if (action === "bind" || action === "mixed") {
    const protocols = action === "mixed" ? arg.split(",") : [arg, arg];
    result = await evaluate(
      `(async()=>{const v=await window.herta.getProviderSettings();const p=v.settings.providers.find(p=>p.protocol===${JSON.stringify(protocols[0])});const x=v.settings.providers.find(p=>p.protocol===${JSON.stringify(protocols[1])});if(!p||!x)throw new Error('Missing provider');await window.herta.setProviderBindings({bindings:{persona:{providerId:p.id,modelId:${JSON.stringify(model)}},executor:{providerId:x.id,modelId:${JSON.stringify(model)}}}});return {persona:p.protocol,executor:x.protocol,model:${JSON.stringify(model)}};})()`,
    );
  } else if (action === "submit") {
    result = await invoke("submitText", arg);
  } else if (action === "approve" || action === "deny") {
    result = await evaluate(
      `(async()=>{const r=window.__r3Overlay;if(!r)throw new Error('No approval');return await window.herta.resolveApproval({requestId:r.requestId,decision:${JSON.stringify(action === "approve" ? "allow" : "deny")},persistence:'once'});})()`,
    );
  } else if (action === "watch") {
    await evaluate(
      `(()=>{window.__r3Events=[];window.__r3Overlay=null;window.__r3Off?.forEach(f=>f());window.__r3Off=[window.herta.onOverlay(e=>{window.__r3Overlay=e.state??e.overlay??null;window.__r3Events.push({channel:'overlay',event:e});}),window.herta.onTurn(e=>window.__r3Events.push({channel:'turn',event:e})),window.herta.onRecord(e=>window.__r3Events.push({channel:'record',event:e}))];return true;})()`,
    );
    result = { watching: true };
  } else if (action === "events") {
    result = await evaluate(
      "({overlay:window.__r3Overlay,events:window.__r3Events??[]})",
    );
    if (arg && /^[a-z0-9-]+$/.test(arg))
      writeFileSync(
        resolve(evidence, `${arg}.json`),
        JSON.stringify(result, null, 2),
      );
  } else throw new Error("Unknown action");
  console.log(JSON.stringify(result));
} finally {
  ws.close();
}
