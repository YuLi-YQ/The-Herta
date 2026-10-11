/** Measured actual packaged renderer on 9346; synthetic history is not an API pass. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const evidence = resolve("docs/reports/evidence/round-4");
const label = process.argv[2] ?? "performance-renderer-fixed";
assert(/^[a-z0-9-]+$/.test(label), "Expected safe evidence label");
const fixtureId = "8f6b79f8-08b3-46a3-89a7-6d2e60e591e6";
const fixtureFile = resolve(
  ".verification/round-4/profile-performance/.herta/transcript/v2",
  `${fixtureId}.jsonl`,
);
let original = "";
function findEvidence(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (
      key === "evidenceDetail" &&
      typeof item === "string" &&
      item.length > original.length
    )
      original = item;
    else if (item && typeof item === "object") findEvidence(item);
  }
}
for (const line of readFileSync(fixtureFile, "utf8")
  .split("\n")
  .filter(Boolean))
  findEvidence(JSON.parse(line));
assert(
  original.length >= 500_000,
  "Unmodified synthetic fixture contains all large output",
);
mkdirSync(evidence, { recursive: true });
const pages = await (await fetch("http://127.0.0.1:9346/json/list")).json();
const page = pages.find((p) => p.type === "page" && p.url.startsWith("file:"));
assert(page, "Expected isolated packaged performance renderer");
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
      ? task.reject(new Error("Performance CDP rejected"))
      : task.done(message.result);
  }
});
const call = (method, params = {}) =>
  new Promise((done, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Performance response exceeded 30 seconds"));
    }, 30000);
    pending.set(id, { done, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error("Performance evaluation failed; no raw history emitted");
  return result.result.value;
}
const frame =
  "await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))";
async function dimensions() {
  const viewport = await evaluate(
    "(()=>{const c=document.querySelector('.herta-content');const articles=document.querySelectorAll('.herta-transcript>article');const details=[...document.querySelectorAll('.herta-transcript details')].filter(d=>d.querySelector('summary')?.textContent==='执行结果与证据');const blocks=details.flatMap(d=>[...d.querySelectorAll('pre')]);return {viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},visibleRecordArticles:articles.length,documentElements:document.querySelectorAll('*').length,documentTextChars:document.body.textContent.length,largestMountedEvidenceChars:Math.max(0,...blocks.map(e=>e.textContent.length)),largestMountedEvidenceUTF8Bytes:Math.max(0,...blocks.map(e=>new TextEncoder().encode(e.textContent).length)),evidenceDetails:details.length,openEvidenceDetails:details.filter(d=>d.open).length,contentScrollHeight:c.scrollHeight,contentClientHeight:c.clientHeight,horizontalOverflow:document.documentElement.scrollWidth>innerWidth};})()",
  );
  const dom = await call("Memory.getDOMCounters");
  const metrics = await call("Performance.getMetrics");
  const names = [
    "JSHeapUsedSize",
    "JSHeapTotalSize",
    "LayoutCount",
    "RecalcStyleCount",
    "LayoutDuration",
    "RecalcStyleDuration",
    "ScriptDuration",
    "TaskDuration",
  ];
  return {
    ...viewport,
    dom,
    rendererMetrics: Object.fromEntries(
      metrics.metrics
        .filter((m) => names.includes(m.name))
        .map((m) => [m.name, m.value]),
    ),
  };
}
async function measure(expression) {
  const start = performance.now();
  const details = await evaluate(
    `(async()=>{const start=performance.now();${expression};${frame};return {rendererToDoubleRafMs:performance.now()-start};})()`,
  );
  return { cdpRoundTripToDoubleRafMs: performance.now() - start, ...details };
}
const samples = [];
const results = {
  scope:
    "Actual installed packaged Electron, isolated profile-performance on port 9346, synthetic 120-message + large evidence history; no API test",
  measurement:
    "Chromium DOM/heap snapshots; two requestAnimationFrame callbacks after operation; CDP insertText to doubleRAF, not OS IME or hardware typing latency",
  samples,
  fixture: {
    sessionId: fixtureId,
    sourceChars: original.length,
    sourceUTF8Bytes: Buffer.byteLength(original),
    sourceSha256: createHash("sha256").update(original).digest("hex"),
  },
};
try {
  await call("Performance.enable");
  await evaluate(
    "(()=>{const t=document.querySelector('#herta-draft');if(!t)throw new Error('No composer');window.__r4PerfDraft=t.value;window.__r4PerfScroll=document.querySelector('.herta-content').scrollTop;window.__r4PerfEvidence=[...document.querySelectorAll('.herta-transcript details')].find(d=>d.querySelector('summary')?.textContent==='执行结果与证据');if(!window.__r4PerfEvidence)throw new Error('Fixture evidence missing');return true;})()",
  );
  results.initial = await dimensions();
  assert(
    results.initial.visibleRecordArticles >= 120 &&
      results.initial.largestMountedEvidenceChars === 0,
    "120 loaded records and no eagerly mounted output while collapsed",
  );
  assert(
    results.initial.openEvidenceDetails === 0,
    "Large evidence defaults to collapsed",
  );
  for (let i = 0; i < 3; i++) {
    samples.push({
      operation: "expand-large-output",
      sample: i + 1,
      ...(await measure("window.__r4PerfEvidence.open=true")),
    });
    if (i === 0) results.expanded = await dimensions();
    assert(
      (await dimensions()).largestMountedEvidenceChars <= 8001,
      "Expanded output DOM is page bounded",
    );
    samples.push({
      operation: "scroll-expanded-output",
      sample: i + 1,
      ...(await measure(
        "const c=document.querySelector('.herta-content');c.scrollTop=c.scrollHeight",
      )),
    });
    samples.push({
      operation: "collapse-large-output",
      sample: i + 1,
      ...(await measure("window.__r4PerfEvidence.open=false")),
    });
    await evaluate(
      "(()=>{const t=document.querySelector('#herta-draft');t.focus();window.__r4PerfInputAt=null;t.addEventListener('input',()=>window.__r4PerfInputAt=performance.now(),{once:true});return true;})()",
    );
    const started = performance.now();
    await call("Input.insertText", { text: ` R4_PERF_${i}` });
    const response = await evaluate(
      `(async()=>{${frame};const t=document.querySelector('#herta-draft');return {inputEventToDoubleRafMs:performance.now()-window.__r4PerfInputAt,inputDelivered:t.value.includes('R4_PERF_${i}'),draftChars:t.value.length};})()`,
    );
    assert(
      response.inputDelivered,
      "Actual Chromium input event must update composer",
    );
    samples.push({
      operation: "insert-text-response",
      sample: i + 1,
      cdpInputToDoubleRafMs: performance.now() - started,
      ...response,
    });
  }
  await measure("window.__r4PerfEvidence.open=true");
  let joined = "";
  let pageCount = 0;
  let maxMounted = 0;
  while (true) {
    const current = await evaluate(
      "(()=>{const d=window.__r4PerfEvidence;return {text:d.querySelector('pre').textContent,nextDisabled:[...d.querySelectorAll('button')].find(b=>b.textContent==='下一页').disabled,label:d.querySelector('fieldset p').textContent};})()",
    );
    maxMounted = Math.max(maxMounted, current.text.length);
    assert(
      current.text.length <= 8001,
      "Each page is bounded, including surrogate boundaries",
    );
    joined += current.text;
    pageCount++;
    if (current.nextDisabled) {
      results.lastPage = {
        chars: current.text.length,
        label: current.label,
        nextDisabled: true,
      };
      break;
    }
    assert(pageCount < 1000, "Pagination must progress");
    await measure(
      "[...window.__r4PerfEvidence.querySelectorAll('button')].find(b=>b.textContent==='下一页').click()",
    );
  }
  assert.equal(
    joined,
    original,
    "Concatenating every actual rendered page preserves complete original fixture output",
  );
  results.pagination = {
    pageCount,
    maxMountedChars: maxMounted,
    allContentPreserved: true,
    joinedChars: joined.length,
    joinedUTF8Bytes: Buffer.byteLength(joined),
    joinedSha256: createHash("sha256").update(joined).digest("hex"),
  };
  await measure("window.__r4PerfEvidence.open=false");
  results.final = await dimensions();
  results.functionalityPassed = true;
  results.firstExpandBudgetMs = 250;
  results.performanceIssue =
    samples.find((s) => s.operation === "expand-large-output")
      .rendererToDoubleRafMs >= 250;
  results.performanceAccepted = !results.performanceIssue;
} catch (error) {
  results.functionalityPassed = false;
  results.performanceAccepted = false;
  results.error = error.message;
  process.exitCode = 1;
} finally {
  // Restore local draft and scroll; do not submit, alter providers, or close app.
  await evaluate(
    `(async()=>{const t=document.querySelector('#herta-draft');if(t&&typeof window.__r4PerfDraft==='string'){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,window.__r4PerfDraft);t.dispatchEvent(new Event('input',{bubbles:true}));}for(const p of document.querySelectorAll('.herta-transcript details pre'))p.closest('details').open=false;const c=document.querySelector('.herta-content');if(c&&typeof window.__r4PerfScroll==='number')c.scrollTop=window.__r4PerfScroll;${frame};return {draftRestored:t?.value===window.__r4PerfDraft};})()`,
  )
    .then((r) => {
      results.restoration = r;
    })
    .catch(() => {
      results.restoration = { failed: true };
    });
  writeFileSync(
    resolve(evidence, `${label}-results.json`),
    JSON.stringify(results, null, 2),
  );
  ws.close();
}
console.log(JSON.stringify(results));
