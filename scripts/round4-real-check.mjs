/** Actual installed Electron + user-authorized DeepSeek compatibility service.
 * No key retrieval. Restricted once-only approvals in fresh test projects. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const evidence = resolve("docs/reports/evidence/round-4");
const runLabel = `real-${Date.now()}`;
const projects = resolve(".verification/round-4", runLabel);
mkdirSync(evidence, { recursive: true });
mkdirSync(projects, { recursive: true });
const pages = await (await fetch("http://127.0.0.1:9345/json/list")).json();
const page = pages.find((p) => p.type === "page" && p.url.startsWith("file:"));
if (!page) throw new Error("Installed desktop unavailable");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((done, reject) => {
  ws.addEventListener("open", done, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let serial = 0;
const pending = new Map();
const results = [];
ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  const task = pending.get(message.id);
  if (task) {
    clearTimeout(task.timer);
    pending.delete(message.id);
    message.error
      ? task.reject(new Error("CDP rejected"))
      : task.done(message.result);
  }
});
function safe(value) {
  if (
    typeof value === "string" &&
    /sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+/i.test(value)
  )
    throw new Error("Secret-like output suppressed");
  if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (
        /^(api.?key|credential(?:ref)?|secret|authorization|x-api-key)$/i.test(
          key,
        )
      )
        throw new Error("Secret field suppressed");
      safe(item);
    }
  return value;
}
function call(method, params = {}) {
  return new Promise((done, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("CDP timed out"));
    }, 210000);
    pending.set(id, { done, reject, timer });
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
    throw new Error("Electron IPC rejected; raw exception suppressed");
  return safe(result.result.value);
}
const invoke = (method, input) =>
  evaluate(
    `window.herta.${method}(${input === undefined ? "" : JSON.stringify(input)})`,
  );
function checkpoint() {
  writeFileSync(
    resolve(evidence, `${runLabel}-results.json`),
    JSON.stringify(
      safe({
        realExternalService: true,
        service:
          "DeepSeek compatibility service; not official OpenAI/Anthropic",
        model: "deepseek-flash",
        projects,
        results,
      }),
      null,
      2,
    ),
  );
}
async function watch() {
  await evaluate(
    "(()=>{window.__r4RealOff?.forEach(f=>f());window.__r4Real={events:[],overlay:null};const push=(channel,event)=>window.__r4Real.events.push({channel,event});window.__r4RealOff=[window.herta.onOverlay(e=>{if(e.kind==='pending')window.__r4Real.overlay=e.overlay;else if(e.kind==='resolved'&&window.__r4Real.overlay?.requestId===e.requestId)window.__r4Real.overlay=null;push('overlay',e);}),window.herta.onTurn(e=>push('turn',e)),window.herta.onRecord(e=>push('record',e)),window.herta.onLive(e=>push('live',e))];return true;})()",
  );
}
const state = () => evaluate("window.__r4Real");
const canonicalCode = (text) =>
  text.replace(/\r/g, "").replace(/[\s;]/g, "").replace(/'/g, '"');
function approvedShape(overlay, expectedCode, phase) {
  if (phase === "deny")
    return (
      overlay.tool === "write_new_file" &&
      overlay.files?.length === 1 &&
      overlay.files[0] === "denied.txt"
    );
  if (
    overlay.kind === "pending-permission" &&
    overlay.tool === "write_new_file" &&
    overlay.files?.length === 1 &&
    overlay.files[0] === "check.mjs"
  ) {
    const added = (overlay.diff ?? "")
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++ "))
      .map((line) => line.slice(1))
      .join("\n");
    return canonicalCode(added) === canonicalCode(expectedCode);
  }
  return (
    overlay.tool === "run_command" &&
    overlay.command?.trim() === "node check.mjs"
  );
}
async function turn({
  label,
  sessionId,
  root,
  phase,
  prompt,
  expectedCode,
  marker,
}) {
  await watch();
  const approvals = [];
  const handled = new Set();
  let submittedDone = false;
  let submitError;
  let submitResult;
  const submitted = invoke("submitText", prompt).then(
    (value) => {
      submitResult = value;
      submittedDone = true;
    },
    (error) => {
      submitError = error;
      submittedDone = true;
    },
  );
  const start = Date.now();
  let captured;
  try {
    while (Date.now() - start < 180000) {
      captured = await state();
      const overlay = captured.overlay;
      if (overlay && !handled.has(overlay.requestId)) {
        if (!approvedShape(overlay, expectedCode, phase)) {
          const blocked = {
            label,
            sessionId,
            phase,
            unexpectedApproval: overlay,
            status: "blocked",
          };
          results.push(blocked);
          checkpoint();
          console.log(JSON.stringify(safe(blocked)));
          throw new Error(
            "Unexpected tool/command: review needed; no approval issued",
          );
        }
        handled.add(overlay.requestId);
        const decision = phase === "deny" ? "deny" : "allow";
        const approval = {
          requestId: overlay.requestId,
          decision,
          persistence: "once",
        };
        const resolved = await invoke("resolveApproval", approval);
        assert.equal(
          resolved.ok,
          true,
          "Actual request must accept once resolution",
        );
        approvals.push({ overlay, approval, result: resolved });
        console.log(
          JSON.stringify({
            label,
            sessionId,
            approvedTool: overlay.tool,
            command: overlay.command,
            decision,
            requestId: overlay.requestId,
          }),
        );
      }
      if (submittedDone) break;
      await new Promise((done) => setTimeout(done, 150));
    }
    if (!submittedDone) throw new Error("Real task exceeded 180 seconds");
    await submitted;
    if (submitError) throw submitError;
    captured = await state();
    assert(
      captured.events.some(
        (e) => e.channel === "turn" && e.event.kind === "finished",
      ),
      "Real turn must finish",
    );
    assert(
      !captured.events.some(
        (e) => e.channel === "turn" && e.event.kind === "failed",
      ),
      "Real turn must not fail",
    );
    if (phase === "deny") {
      assert(
        approvals.length >= 1 &&
          approvals.every((a) => a.approval.decision === "deny"),
      );
      assert.equal(
        existsSync(resolve(root, "denied.txt")),
        false,
        "Rejected file must not exist",
      );
    } else {
      const source = readFileSync(resolve(root, "check.mjs"), "utf8");
      assert.equal(
        canonicalCode(source),
        canonicalCode(expectedCode),
        "Actual disk script matches approved diff",
      );
      assert(approvals.some((a) => a.overlay.tool === "write_new_file"));
      assert(approvals.some((a) => a.overlay.tool === "run_command"));
      assert(
        captured.events.some(
          (e) =>
            e.channel === "live" &&
            e.event.views.some(
              (v) => v.tool === "run_command" && v.done && v.ok === true,
            ),
        ),
        "Real command tool must report ok",
      );
      assert(
        JSON.stringify(captured.events).includes(marker),
        "Actual command output marker must be present",
      );
      assert(
        captured.events.some(
          (e) =>
            e.channel === "record" && e.event.block?.digest?.exitCode === 0,
        ),
        "Deterministic tool result must contain actual exit code 0",
      );
      assert.equal(existsSync(resolve(root, "denied.txt")), false);
    }
    const snapshot = await invoke("openSession", sessionId);
    const result = {
      label,
      sessionId,
      phase,
      status: "passed",
      elapsedMs: Date.now() - start,
      submitResult,
      approvals,
      record: snapshot.record,
      events: captured.events,
      disk: readdirSync(root).map((name) => ({
        name,
        ...(name === "check.mjs"
          ? {
              sha256: createHash("sha256")
                .update(readFileSync(resolve(root, name)))
                .digest("hex"),
              source: readFileSync(resolve(root, name), "utf8"),
            }
          : {}),
      })),
    };
    results.push(result);
    checkpoint();
    console.log(
      JSON.stringify({
        label,
        phase,
        sessionId,
        status: result.status,
        elapsedMs: result.elapsedMs,
        approvals: approvals.length,
      }),
    );
  } finally {
    if (!submittedDone) {
      await invoke("interrupt").catch(() => {});
      await submitted;
    }
    await evaluate(
      "(()=>{window.__r4RealOff?.forEach(f=>f());window.__r4RealOff=[];return true;})()",
    ).catch(() => {});
  }
}
try {
  const available = await evaluate(
    "(async()=>{const v=await window.herta.getProviderSettings();return v.settings.providers.filter(p=>p.name.startsWith('R4 DeepSeek ')).map(p=>({id:p.id,name:p.name,protocol:p.protocol,baseURL:p.baseURL,revision:p.revision,models:p.models.map(m=>({id:m.id,validation:m.validation,tools:m.capabilities.tools}))}));})()",
  );
  const protocols = [
    "openai-responses",
    "openai-chat-completions",
    "anthropic-messages",
  ];
  const byProtocol = new Map(available.map((p) => [p.protocol, p]));
  for (const protocol of protocols) {
    const p = byProtocol.get(protocol);
    assert(p, "Expected existing authorized connection");
    assert.equal(
      new URL(p.baseURL).origin,
      "https://api.deepseek.com",
      "Only user-authorized service",
    );
    assert(
      p.models.some(
        (m) =>
          m.id === "deepseek-flash" &&
          m.validation.state === "tools-available" &&
          m.validation.providerRevision === p.revision &&
          m.tools === "supported",
      ),
    );
  }
  const cases = protocols.map((protocol) => ({
    label: protocol,
    persona: protocol,
    executor: protocol,
    deny: true,
  }));
  cases.push({
    label: "mixed-responses-messages",
    persona: "openai-responses",
    executor: "anthropic-messages",
    deny: false,
  });
  for (const current of cases) {
    const bindings = {
      persona: {
        providerId: byProtocol.get(current.persona).id,
        modelId: "deepseek-flash",
      },
      executor: {
        providerId: byProtocol.get(current.executor).id,
        modelId: "deepseek-flash",
      },
    };
    await evaluate(
      `(async()=>{await window.herta.setProviderBindings(${JSON.stringify({ bindings })});return true;})()`,
    );
    const root = resolve(projects, `第四轮 黑塔 实验室（${current.label}）`);
    mkdirSync(root, { recursive: true });
    // A local nested repository prevents parent-worktree status from entering
    // the model's context. No commit, global configuration, or network access.
    execFileSync("git", ["init", "--quiet", "--", root], { windowsHide: true });
    const session = await invoke("createSession", {
      workspaceRoot: root,
      backendWorkspace: root,
      lang: "zh",
    });
    assert(session.sessionId);
    if (current.deny)
      await turn({
        label: current.label,
        sessionId: session.sessionId,
        root,
        phase: "deny",
        prompt:
          "请派发执行器，仅在当前隔离项目尝试用 write_new_file 创建 denied.txt，内容为 DENIED_TEST。此次审批将被拒绝；收到拒绝就停止，不要改名、绕过或重试，不运行命令。最后准确报告是否创建成功。",
      });
    const marker = `HERTA_R4_${current.label.replace(/-/g, "_")}_OK`;
    const code = `import assert from "node:assert/strict";\nassert.equal(2 + 3, 5);\nconsole.log("${marker}");\n`;
    await turn({
      label: current.label,
      sessionId: session.sessionId,
      root,
      phase: "allow",
      expectedCode: code,
      marker,
      prompt: `这是新的独立任务，请派发执行器完成真实操作。保留 denied.txt 不存在。仅在当前隔离项目使用 write_new_file 创建 check.mjs，内容逐字为：\n${code}\n随后仅使用 run_command 的 argv=["node","check.mjs"] 在当前项目执行检查。禁止 shell 链、联网、删除、其他写入或安装，不创建其他文件。等待每项审批，工具完成后根据实际 stdout 和 exit code 报告结论。`,
    });
  }
} catch (error) {
  results.push({ status: "failed-or-blocked", message: safe(error.message) });
  checkpoint();
  console.error(
    JSON.stringify({
      realExternalService: true,
      status: "failed-or-blocked",
      message: safe(error.message),
      evidence: `${runLabel}-results.json`,
    }),
  );
  process.exitCode = 1;
} finally {
  await invoke("interrupt").catch(() => {});
  await evaluate(
    "(()=>{window.__r4RealOff?.forEach(f=>f());window.__r4RealOff=[];return true;})()",
  ).catch(() => {});
  checkpoint();
  ws.close();
  console.log(
    JSON.stringify({
      finished: true,
      evidence: `${runLabel}-results.json`,
      retainedProviders: true,
      projectRoot: projects,
    }),
  );
}
