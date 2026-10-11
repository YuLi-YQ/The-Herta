/** Synthetic workload in an isolated profile, never a real-service evidence claim. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const profile = resolve(".verification/round-4/profile-performance");
const project = join(profile, "黑塔 实验室（性能测试）");
const sessionId = randomUUID();
const directory = join(profile, ".herta", "transcript", "v2");
mkdirSync(directory, { recursive: true });
mkdirSync(project, { recursive: true });
const at = new Date().toISOString();
const rows = [
  {
    _kind: "session_meta",
    version: 1,
    sessionId,
    workspaceRoot: profile,
    backendWorkspace: project,
    startedAt: at,
    lang: "zh",
  },
];
for (let n = 0; n < 120; n++)
  rows.push(
    n % 2 === 0
      ? {
          kind: "user",
          text: `确定性性能样本 ${n}：${"中文长记录与代码阅读 ".repeat(80)}`,
          at,
        }
      : {
          kind: "herta",
          surface: "speech",
          text: `性能样本回复 ${n}：\n${"const value = '仅为性能数据';\n".repeat(120)}`,
          at,
        },
  );
const output = "确定性工具输出，未运行模型或命令。0123456789\n".repeat(20000);
rows.push({
  kind: "system",
  label: "系统",
  body: "性能数据集：大输出默认折叠；不是实际工具执行通过。",
  evidenceDetail: output,
  at,
});
rows.push({
  _kind: "turn_end",
  turnId: randomUUID(),
  outcome: "completed",
  at,
});
const text = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
writeFileSync(join(directory, `${sessionId}.jsonl`), text);
const metadata = {
  syntheticWorkload: true,
  realAPI: false,
  profile,
  project,
  sessionId,
  messageCount: 120,
  largeOutputBytes: Buffer.byteLength(output),
  transcriptBytes: Buffer.byteLength(text),
  sha256: createHash("sha256").update(text).digest("hex"),
};
writeFileSync(
  resolve("docs/reports/evidence/round-4/performance-dataset.json"),
  JSON.stringify(metadata, null, 2),
);
console.log(JSON.stringify(metadata));
