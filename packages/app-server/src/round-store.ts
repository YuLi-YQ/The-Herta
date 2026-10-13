import { mergeSearchEvent } from "@herta/providers";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  opendirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentEvent } from "@herta/core";
import {
  computeUnifiedDiff,
  isCredentialBasename,
  isSensitiveSegment,
  redactSecrets,
} from "@herta/tools";
import type {
  RoundActivity,
  RoundFile,
  RoundFileContent,
  RoundStatus,
  RoundSummary,
} from "./round-summary.js";

type Snapshot = { hash: string; ref: string | null; unavailable?: string };
type FrozenFile = {
  path: string;
  before: Snapshot | null;
  after: Snapshot | null;
  sourceLabel?: string;
};
type StoredRound = {
  summary: RoundSummary;
  baseline: Record<string, Snapshot>;
  baselineComplete?: boolean;
  contents: Record<string, FrozenFile>;
  workspace: string;
};
const FILE_LIMIT = 256 * 1024;
const ROUND_LIMIT = 8 * 1024 * 1024;
const EXCLUDED = new Set([
  "node_modules",
  ".git",
  ".herta",
  ".codex",
  ".runtime",
  "dist",
  "build",
  "vendor",
  ".verification",
]);
const digest = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
const clean = (text: string) =>
  redactSecrets(text).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
const safeObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const emptyMetrics = () => ({
  totalTokens: null,
  cacheHitRate: null,
  outputTokensPerSecond: null,
  contextUsed: null,
  contextWindow: null,
  partial: true,
});

/** Exact line counts with bounded memory/work; pathological diffs remain unknown. */
export function lineCounts(
  before: string,
  after: string,
): { added: number | null; removed: number | null } {
  const lines = (s: string) => (s ? s.replace(/\n$/, "").split("\n") : []);
  const originalA = lines(before);
  const originalB = lines(after);
  let start = 0;
  while (
    start < originalA.length &&
    start < originalB.length &&
    originalA[start] === originalB[start]
  )
    start++;
  let endA = originalA.length;
  let endB = originalB.length;
  while (
    endA > start &&
    endB > start &&
    originalA[endA - 1] === originalB[endB - 1]
  ) {
    endA--;
    endB--;
  }
  const a = originalA.slice(start, endA);
  const b = originalB.slice(start, endB);
  if (a.length * b.length > 2_000_000) return { added: null, removed: null };
  const row = new Uint32Array(b.length + 1);
  for (const x of a) {
    let previous = 0;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j] ?? 0;
      row[j] = x === b[j - 1] ? previous + 1 : Math.max(old, row[j - 1] ?? 0);
      previous = old;
    }
  }
  return {
    added: b.length - (row[b.length] ?? 0),
    removed: a.length - (row[b.length] ?? 0),
  };
}

/** Append-only historical snapshots; synchronous event boundaries capture before execution. */
export class RoundStore {
  search(event: import("@herta/providers").WebSearchEvent): void {
    if (!this.active) return;
    mergeSearchEvent(this.active.summary.searches ??= [], event);
    this.persist();
  }
  reasoning(
    id: string,
    role: "persona" | "executor",
    text: string,
    format: "text" | "summary",
  ): void {
    if (!this.active || !text) return;
    const items = (this.active.summary.publicReasoning ??= []);
    let item = items.find((i) => i.id === id);
    if (!item) {
      if (items.length >= 32) {
        this.note("思考展示最多保留32次请求");
        return;
      }
      item = { id, role, format, text: "", truncated: false };
      items.push(item);
    }
    const joined = clean(item.text + text);
    item.text = joined.slice(0, 24000);
    item.truncated ||= joined.length > 24000;
  }
  private rounds: StoredRound[] = [];
  private active: StoredRound | null = null;
  private clocks = new Map<string, number>();
  private beforeCalls = new Map<string, Record<string, Snapshot>>();
  private inputCalls = new Map<string, Record<string, unknown>>();
  private callClocks = new Map<string, number>();
  private bytes = 0;
  // Ephemeral within a logical round. File identity plus nanosecond change
  // timestamps invalidates replacement, same-size writes and restored mtime.
  private scanCache = new Map<string, { stamp: string; snapshot: Snapshot }>();
  private fault: string | null = null;
  private incomplete = new WeakSet<Record<string, Snapshot>>();
  constructor(
    private readonly path: string,
    private readonly sessionId: string,
    private readonly workspace: () => string,
  ) {
    if (existsSync(path)) {
      try {
        const saved = JSON.parse(readFileSync(path, "utf8"));
        if (saved.schemaVersion !== 1 || !Array.isArray(saved.rounds))
          throw new Error("schema");
        this.rounds = saved.rounds;
      } catch {
        this.fault = "历史摘要暂不可用：存储无法读取";
      }
    }
    for (const round of this.rounds) {
      if (round.baselineComplete !== true) this.incomplete.add(round.baseline);
      if (round.summary.status === "running") {
        round.summary.status = "interrupted";
        round.summary.durationMs = null;
        round.summary.endedAt = null;
        round.summary.limitations.push(
          "应用退出时处理未结束；持续时长及未返回工具结果未知",
        );
      }
      for (const activity of round.summary.activities)
        if (activity.status === "running") activity.status = "unknown";
    }
  }
  private persist(): void {
    if (this.fault) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ schemaVersion: 1, rounds: this.rounds }),
        "utf8",
      );
      renameSync(tmp, this.path);
    } catch {
      this.active?.summary.limitations.push("摘要写入失败；本轮历史可能不完整");
    }
  }
  private note(text: string): void {
    if (this.active && !this.active.summary.limitations.includes(text))
      this.active.summary.limitations.push(text);
  }
  private allowed(path: string): boolean {
    return path
      .split(/[\\/]/)
      .every(
        (p) =>
          !EXCLUDED.has(p.toLowerCase()) &&
          !isSensitiveSegment(p) &&
          !isCredentialBasename(p),
      );
  }
  private capture(root: string): Record<string, Snapshot> {
    const result: Record<string, Snapshot> = {};
    let seen = 0;
    let scanned = 0;
    const walk = (folder: string, depth: number) => {
      if (depth > 12) {
        this.incomplete.add(result);
        this.note("深于12层的目录未扫描");
        return;
      }
      if (seen >= 2000) {
        this.incomplete.add(result);
        this.note("扫描达到2000项上限；未扫描部分不计为无变化");
        return;
      }
      let directory;
      try {
        directory = opendirSync(folder);
      } catch (error) {
        // A fresh isolated workspace may be created by its first write tool.
        // Missing root is a known empty baseline; an unreadable existing root
        // or a disappearing child directory remains an incomplete scan.
        if (depth === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") return;
        this.incomplete.add(result);
        this.note("部分目录不可读，扫描不完整");
        return;
      }
      try {
        let entry;
        while ((entry = directory.readSync()) !== null) {
          if (++seen > 2000) {
            this.incomplete.add(result);
            this.note("扫描达到2000项上限；未扫描部分不计为无变化");
            return;
          }
          const abs = join(folder, entry.name);
          const rel = relative(root, abs).split(sep).join("/");
          if (!this.allowed(rel) || entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            walk(abs, depth + 1);
            continue;
          }
          if (!entry.isFile()) continue;
          try {
            const stat = statSync(abs, { bigint: true });
            const size = Number(stat.size);
            const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
            if (size > FILE_LIMIT) {
              result[rel] = {
                hash: "unscanned",
                ref: null,
                unavailable: "超过256KiB上限",
              };
              this.note("超过256KiB的文件不保存内容或推断变化");
              continue;
            }
            if (scanned + size > ROUND_LIMIT) {
              this.incomplete.add(result);
              result[rel] = {
                hash: "unscanned",
                ref: null,
                unavailable: "扫描达到8MiB上限",
              };
              this.note("扫描达到8MiB上限；未扫描部分不计为无变化");
              continue;
            }
            scanned += size;
            const cached = this.scanCache.get(abs);
            if (cached?.stamp === stamp) {
              result[rel] = cached.snapshot;
              continue;
            }
            this.scanCache.delete(abs);
            const data = readFileSync(abs);
            const afterStat = statSync(abs, { bigint: true });
            const afterStamp = `${afterStat.dev}:${afterStat.ino}:${afterStat.size}:${afterStat.mtimeNs}:${afterStat.ctimeNs}`;
            if (afterStamp !== stamp) {
              this.incomplete.add(result);
              result[rel] = {
                hash: "unscanned",
                ref: null,
                unavailable: "扫描期间文件变化，快照未确认",
              };
              this.note("部分文件在扫描期间变化，未推断其变更");
              continue;
            }
            const hash = digest(data);
            let text: string;
            try {
              if (data.includes(0)) throw new Error("binary");
              text = new TextDecoder("utf-8", { fatal: true }).decode(data);
            } catch {
              result[rel] = {
                hash,
                ref: null,
                unavailable: "二进制或非UTF-8文件，未保存文本",
              };
              continue;
            }
            const sanitized = clean(text);
            const ref = digest(sanitized);
            const file = join(`${this.path}.snapshots`, ref);
            if (!existsSync(file)) {
              if (this.bytes + Buffer.byteLength(sanitized) > ROUND_LIMIT) {
                result[rel] = {
                  hash,
                  ref: null,
                  unavailable: "本轮快照达到8MiB上限",
                };
                continue;
              }
              mkdirSync(dirname(file), { recursive: true });
              writeFileSync(file, sanitized, "utf8");
              this.bytes += Buffer.byteLength(sanitized);
            }
            result[rel] = {
              hash,
              ref,
              ...(sanitized !== text
                ? { unavailable: "敏感内容已遮蔽；显示为脱敏快照" }
                : {}),
            };
            this.scanCache.set(abs, { stamp, snapshot: result[rel]! });
          } catch {
            this.scanCache.delete(abs);
            this.incomplete.add(result);
            this.note("部分文件读取失败，扫描不完整");
          }
        }
      } catch {
        this.incomplete.add(result);
        this.note("部分目录不可读，扫描不完整");
      } finally {
        directory.closeSync();
      }
    };
    walk(root, 0);
    const present = new Set(
      Object.keys(result).map((rel) => resolve(root, rel)),
    );
    for (const key of this.scanCache.keys())
      if (!present.has(key)) this.scanCache.delete(key);
    this.note(
      "仅扫描工作区内文本；依赖、构建、内部及凭据目录、符号链接不纳入；期间观测变化归属不确定",
    );
    return result;
  }
  begin(attemptId: string, recordStart: number, continuation = false): void {
    const last = this.rounds.at(-1);
    this.active = continuation && last ? last : null;
    if (!this.active) {
      this.active = {
        workspace: resolve(this.workspace()),
        baseline: {},
        contents: {},
        summary: {
          schemaVersion: 1,
          id: randomUUID(),
          sessionId: this.sessionId,
          attemptIds: [],
          recordStart,
          startedAt: new Date().toISOString(),
          endedAt: null,
          durationMs: null,
          status: "running",
          files: [],
          activities: [],
          metrics: emptyMetrics(),
          limitations: [],
        },
      };
      this.rounds.push(this.active);
      this.clocks.set(this.active.summary.id, performance.now());
      this.bytes = 0;
      this.scanCache.clear();
      this.active.baseline = this.capture(this.active.workspace);
      this.active.baselineComplete = !this.incomplete.has(this.active.baseline);
    }
    this.active.summary.attemptIds.push(attemptId);
    this.active.summary.status = "running";
    this.active.summary.endedAt = null;
    if (this.fault) this.note(this.fault);
    this.persist();
  }
  private text(snapshot: Snapshot | null): string | null {
    if (!snapshot?.ref || !/^[a-f0-9]{64}$/.test(snapshot.ref)) return null;
    try {
      return readFileSync(join(`${this.path}.snapshots`, snapshot.ref), "utf8");
    } catch {
      return null;
    }
  }
  private file(
    path: string,
    before: Snapshot | null,
    after: Snapshot | null,
    id: string,
  ): RoundFile {
    const round = this.active!;
    round.contents[id] = { path, before, after };
    const beforeText = before ? this.text(before) : "";
    const afterText = after ? this.text(after) : "";
    return {
      id,
      path,
      kind: !before ? "added" : !after ? "deleted" : "modified",
      confidence: "observed",
      ...(beforeText !== null && afterText !== null
        ? lineCounts(beforeText, afterText)
        : { added: null, removed: null }),
      ...(before?.unavailable || after?.unavailable
        ? { unavailable: after?.unavailable ?? before?.unavailable }
        : {}),
    };
  }
  private changes(
    before: Record<string, Snapshot>,
    after: Record<string, Snapshot>,
    prefix: string,
  ): RoundFile[] {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter(
        (path) =>
          before[path]?.hash !== "unscanned" &&
          after[path]?.hash !== "unscanned" &&
          !(!before[path] && this.incomplete.has(before)) &&
          !(!after[path] && this.incomplete.has(after)) &&
          before[path]?.hash !== after[path]?.hash,
      )
      .map((path) =>
        this.file(
          path,
          before[path] ?? null,
          after[path] ?? null,
          `${prefix}-${digest(path).slice(0, 20)}`,
        ),
      );
  }
  private relativePath(value: unknown): string | null {
    if (typeof value !== "string" || !this.active) return null;
    const rel = relative(
      this.active.workspace,
      resolve(this.active.workspace, value),
    );
    return rel &&
      !isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(`..${sep}`) &&
      this.allowed(rel)
      ? rel.split(sep).join("/")
      : null;
  }
  event(event: AgentEvent): void {
    const round = this.active;
    if (!round || event.layer !== "backend") return;
    if (event.type === "tool.call.started") {
      const id = `${round.summary.attemptIds.at(-1)}:${event.id}`;
      if (round.summary.activities.some((a) => a.id === id)) return;
      const input = safeObject(event.input);
      this.inputCalls.set(id, input);
      this.callClocks.set(id, performance.now());
      this.beforeCalls.set(id, this.capture(round.workspace));
      const command =
        typeof input.command === "string" && event.tool !== "str_replace_editor"
          ? input.command
          : Array.isArray(input.argv)
            ? input.argv.join(" ")
            : undefined;
      round.summary.activities.push({
        id,
        attemptId: round.summary.attemptIds.at(-1)!,
        kind: event.tool,
        title: clean(event.inputSummary).slice(0, 240),
        status: "running",
        startedAt: new Date().toISOString(),
        durationMs: null,
        summary: "",
        files: [],
        ...(command ? { command: clean(command).slice(0, 8000) } : {}),
        cwd: round.workspace,
      });
      this.persist();
    } else if (event.type === "tool.call.finished") {
      const id = `${round.summary.attemptIds.at(-1)}:${event.id}`;
      let activity = round.summary.activities.find((a) => a.id === id);
      if (!activity) {
        activity = {
          id,
          attemptId: round.summary.attemptIds.at(-1)!,
          kind: event.tool,
          title: event.tool,
          status: "running",
          durationMs: null,
          summary: "",
          files: [],
        };
        round.summary.activities.push(activity);
      } else if (activity.status !== "running") return;
      const result = event.result;
      const data = safeObject(result.data);
      activity.status = result.ok
        ? data.running === true
          ? "unknown"
          : "succeeded"
        : /denied|blocked|permission/.test(result.error?.code ?? "")
          ? "denied"
          : /abort|cancel/.test(result.error?.code ?? "")
            ? "cancelled"
            : "failed";
      activity.summary = clean(result.summary).slice(0, 1600);
      const started = this.callClocks.get(id);
      activity.durationMs =
        started === undefined ? null : Math.max(0, performance.now() - started);
      if (typeof data.exitCode === "number") activity.exitCode = data.exitCode;
      const detail = clean(
        JSON.stringify(
          {
            ...data,
            ...(result.error ? { error: result.error } : {}),
            ...(result.modelText ? { output: result.modelText } : {}),
          },
          (_key, value) =>
            /^(nativeContext|authorization|apiKey|signature|encrypted_content|images|logPath)$/i.test(
              _key,
            )
              ? undefined
              : value,
          2,
        ),
      );
      const display =
        typeof data.stdout === "string" || typeof data.stderr === "string"
          ? clean(
              `[stdout]\n${typeof data.stdout === "string" ? data.stdout || "无输出" : "未记录"}\n\n[stderr]\n${typeof data.stderr === "string" ? data.stderr || "无输出" : "未记录"}${result.error ? `\n\n[error]\n${result.error.code}: ${result.error.message}` : ""}`,
            )
          : detail;
      activity.detail = display.slice(0, 24000);
      activity.truncated =
        display.length > 24000 ||
        data.stdoutTruncated === true ||
        data.stderrTruncated === true;
      const after = this.capture(round.workspace);
      const before = this.beforeCalls.get(id);
      activity.files = before
        ? this.changes(before, after, id).map((f) => ({
            fileId: f.id,
            path: f.path,
          }))
        : [];
      // Only structured tool results may create links; never scrape paths from output.
      const found = Array.isArray(data.matches)
        ? data.matches
        : Array.isArray(data.files)
          ? data.files
          : [];
      for (const candidate of found.slice(0, 50)) {
        const entry = safeObject(candidate);
        const foundPath = this.relativePath(entry.path);
        if (!foundPath || !after[foundPath]) continue;
        let line =
          typeof entry.line === "number" &&
          Number.isSafeInteger(entry.line) &&
          entry.line > 0
            ? entry.line
            : undefined;
        if (line !== undefined) {
          const savedLine = this.text(after[foundPath]!)?.split(/\r?\n/)[
            line - 1
          ];
          if (
            savedLine === undefined ||
            (typeof entry.content === "string" &&
              clean(entry.content) !== savedLine)
          ) {
            line = undefined;
            this.note("部分搜索匹配与搜索后快照不一致，未提供精确行定位");
          }
        }
        if (activity.files.some((f) => f.path === foundPath && f.line === line))
          continue;
        const fileId = `${id}-found-${digest(foundPath).slice(0, 20)}`;
        round.contents[fileId] = {
          path: foundPath,
          before: after[foundPath]!,
          after: after[foundPath]!,
          sourceLabel: "当次搜索后的文件快照（读取视图）",
        };
        activity.files.push({
          fileId,
          path: foundPath,
          ...(line !== undefined ? { line } : {}),
        });
      }
      if (found.length > 50) this.note("搜索文件链接仅保留前50个结构化结果");
      const input = this.inputCalls.get(id) ?? {};
      const path = this.relativePath(data.relPath ?? data.path ?? input.path);
      if (path && !activity.files.some((f) => f.path === path) && after[path]) {
        const fileId = `${id}-read`;
        round.contents[fileId] = {
          path,
          before: after[path]!,
          after: after[path]!,
        };
        activity.files.push({ fileId, path });
        const fragment =
          typeof data.content === "string"
            ? data.content
            : data.command === "view" && result.modelText
              ? result.modelText
              : null;
        if (fragment !== null) {
          const text = clean(fragment).slice(0, FILE_LIMIT);
          const ref = digest(text);
          const dest = join(`${this.path}.snapshots`, ref);
          if (this.bytes + Buffer.byteLength(text) <= ROUND_LIMIT) {
            mkdirSync(dirname(dest), { recursive: true });
            if (!existsSync(dest)) {
              writeFileSync(dest, text, "utf8");
              this.bytes += Buffer.byteLength(text);
            }
            const snap = {
              hash: ref,
              ref,
              unavailable: "当次工具返回的读取片段，非完整文件",
            };
            round.contents[fileId] = {
              path,
              before: snap,
              after: snap,
              sourceLabel: "当次读取片段",
            };
          }
        }
      }
      round.summary.files = this.changes(round.baseline, after, "net");
      this.beforeCalls.delete(id);
      this.inputCalls.delete(id);
      this.callClocks.delete(id);
      this.persist();
    }
  }
  finish(status: RoundStatus): void {
    const round = this.active;
    if (!round) return;
    round.summary.files = this.changes(
      round.baseline,
      this.capture(round.workspace),
      "net",
    );
    round.summary.status = status;
    if (status !== "waiting") {
      round.summary.endedAt = new Date().toISOString();
      const clock = this.clocks.get(round.summary.id);
      round.summary.durationMs =
        clock === undefined ? null : Math.max(0, performance.now() - clock);
      for (const a of round.summary.activities)
        if (a.status === "running")
          a.status = status === "cancelled" ? "cancelled" : "unknown";
    }
    this.persist();
    this.active = null;
  }
  summaries(): RoundSummary[] {
    return structuredClone(this.rounds.map((r) => r.summary));
  }
  read(roundId: string, fileId: string): RoundFileContent | null {
    const round = this.rounds.find((r) => r.summary.id === roundId);
    const file = round?.contents[fileId];
    if (!file) return null;
    const before = this.text(file.before);
    const after = this.text(file.after);
    return {
      roundId,
      fileId,
      path: file.path,
      before,
      after,
      sourceLabel:
        file.sourceLabel ??
        (fileId.startsWith("net-") ? "本轮净变化" : "当次工具边界快照"),
      ...((!file.before || before !== null) && (!file.after || after !== null)
        ? { diff: computeUnifiedDiff(before ?? "", after ?? "", file.path) }
        : {}),
      ...(file.before?.unavailable || file.after?.unavailable
        ? { unavailable: file.after?.unavailable ?? file.before?.unavailable }
        : {}),
    };
  }
  cancelWaiting(): void {
    const last = this.rounds.at(-1);
    if (last?.summary.status === "waiting") {
      this.active = last;
      this.finish("cancelled");
    }
  }
}
