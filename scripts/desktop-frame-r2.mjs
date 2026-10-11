import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const _mode = process.argv[2] || "create";
const dir = resolve("docs/reports/evidence/round-2");
mkdirSync(dir, { recursive: true });
const _saved = resolve(".verification/round-2-provider-state.json");
const pages = await (await fetch("http://127.0.0.1:9338/json/list")).json();
const ws = new WebSocket(
  pages.find((p) => p.type === "page").webSocketDebuggerUrl,
);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let n = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String(e.data));
  const p = pending.get(m.id);
  if (p) {
    pending.delete(m.id);
    m.error
      ? p.reject(new Error(JSON.stringify(m.error)))
      : p.resolve(m.result);
  }
});
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++n;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
const _invoke = (name, arg) =>
  evaluate(
    `window.herta.${name}(${arg === undefined ? "" : JSON.stringify(arg)})`,
  );
const name = process.argv[2] || "frame";
const frame = await evaluate(
  `({title:document.title,text:document.body.innerText,innerWidth,innerHeight,outerWidth,outerHeight,screenX,screenY,scale:devicePixelRatio,visibility:document.visibilityState,draft:document.querySelector('#herta-draft')?.value,path:document.querySelector('.herta-path')?.textContent,overflow:document.documentElement.scrollWidth>innerWidth})`,
);
const shot = await call("Page.captureScreenshot", { format: "png" });
writeFileSync(join(dir, `${name}.png`), Buffer.from(shot.data, "base64"));
writeFileSync(join(dir, `${name}.json`), JSON.stringify(frame, null, 2));
console.log(JSON.stringify({ name, ...frame }));
ws.close();
