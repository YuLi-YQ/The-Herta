import type {
  RoundActivity,
  RoundFileContent,
  RoundSummary,
} from "@herta/app-server";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RoundFileView } from "./RoundReader.js";
import "./round-results.css";

export interface RoundResultsProps {
  round: RoundSummary;
  onRead: (roundId: string, fileId: string, line?: number) => void;
  loadFile: (
    roundId: string,
    fileId: string,
  ) => Promise<RoundFileContent | null>;
}
const activityLabels: Record<RoundActivity["status"], string> = {
  running: "进行中",
  succeeded: "执行成功",
  failed: "失败",
  cancelled: "已取消",
  denied: "已拒绝",
  unknown: "结果未确认",
};
const roundLabels: Record<RoundSummary["status"], string> = {
  running: "处理中",
  waiting: "等待回复或审批",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
const changeLabels = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
  renamed: "重命名",
};
const toolLabel = (kind: string) =>
  (
    ({
      read_file: "读取",
      edit_file: "编辑",
      write_new_file: "新建",
      run_command: "命令",
      bash: "命令",
      grep: "搜索",
      glob: "查找",
      str_replace_editor: "文件操作",
    }) as Record<string, string>
  )[kind] ?? kind;
export function roundDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "--";
  const seconds = Math.floor(ms / 1000);
  return seconds < 60
    ? `${seconds}秒`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}分${seconds % 60}秒`
      : `${Math.floor(seconds / 3600)}时${Math.floor((seconds % 3600) / 60)}分`;
}
/** Strip terminal controls, not user text; React renders all remaining content as text. */
export function cleanToolText(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function Output({ text, truncated }: { text: string; truncated?: boolean }) {
  const [page, setPage] = useState(0);
  const cleaned = cleanToolText(text);
  const size = 16000;
  const pages = Math.max(1, Math.ceil(cleaned.length / size));
  const current = Math.min(page, pages - 1);
  return (
    <>
      <pre className="round-tool-output" tabIndex={0}>
        {cleaned.slice(current * size, (current + 1) * size) || "无输出"}
      </pre>
      {truncated && <p className="round-note">仅保留部分输出，详情已截断。</p>}
      {pages > 1 && (
        <nav className="round-code-pages" aria-label="输出分页">
          <button
            type="button"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            上一段
          </button>
          <span>
            {current + 1} / {pages}
          </span>
          <button
            type="button"
            disabled={current === pages - 1}
            onClick={() => setPage(current + 1)}
          >
            下一段
          </button>
        </nav>
      )}
    </>
  );
}

function ToolRow({
  activity,
  fileLink,
  roundId,
  loadFile,
}: {
  activity: RoundActivity;
  fileLink: (id: string, path: string, line?: number) => ReactNode;
  roundId: string;
  loadFile: RoundResultsProps["loadFile"];
}) {
  const [copied, setCopied] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [file, setFile] = useState<RoundFileContent | null>(null);
  const firstFile = activity.files[0]?.fileId;
  const fileTool = /edit|write|read|replace/.test(activity.kind);
  useEffect(() => {
    let disposed = false;
    if (expanded && fileTool && firstFile)
      void loadFile(roundId, firstFile).then(
        (value) => {
          if (!disposed) setFile(value);
        },
        () => {},
      );
    return () => {
      disposed = true;
    };
  }, [expanded, fileTool, firstFile, loadFile, roundId]);
  const hasDetails =
    activity.detail !== undefined ||
    activity.command !== undefined ||
    activity.cwd !== undefined ||
    activity.exitCode !== undefined;
  const title = (
    <>
      <span
        className={`round-status-dot is-${activity.status}`}
        aria-hidden="true"
      />
      <small>{toolLabel(activity.kind)} ·</small>
      <span className="round-tool-title">{activity.title}</span>
      <span className={`round-state is-${activity.status}`}>
        {activityLabels[activity.status]}
      </span>
      {activity.durationMs !== null && (
        <span className="round-tool-time">
          {roundDuration(activity.durationMs)}
        </span>
      )}
    </>
  );
  return (
    <li className={`round-tool is-${activity.status}`}>
      {hasDetails ? (
        <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
          <summary>{title}</summary>
          <div className="round-tool-detail">
            {activity.command !== undefined && (
              <div className="round-command">
                <code>{cleanToolText(activity.command)}</code>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(cleanToolText(activity.command ?? ""))
                      .then(
                        () => setCopied("已复制"),
                        () => setCopied("复制失败"),
                      );
                  }}
                >
                  {copied || "复制命令"}
                </button>
              </div>
            )}
            {(activity.cwd || activity.exitCode !== undefined) && (
              <p className="round-note">
                {activity.cwd ? `工作目录：${activity.cwd}` : ""}
                {activity.exitCode !== undefined
                  ? ` · 退出码 ${activity.exitCode}`
                  : ""}
              </p>
            )}
            {file ? (
              <RoundFileView content={file} />
            ) : activity.detail !== undefined ? (
              <Output text={activity.detail} truncated={activity.truncated} />
            ) : (
              <p className="round-note">未记录输出。</p>
            )}
          </div>
        </details>
      ) : (
        <div className="round-tool-static">{title}</div>
      )}
      {activity.summary && (
        <p className="round-tool-summary">{activity.summary}</p>
      )}
      {activity.files.length > 0 && (
        <div className="round-tool-files">
          {activity.files.map((file) => (
            <span key={`${file.fileId}:${file.line ?? ""}`}>
              {fileLink(file.fileId, file.path, file.line)}
              {file.line ? <small> · 行 {file.line}</small> : null}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

export function RoundResults({ round, onRead, loadFile }: RoundResultsProps) {
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [filter, setFilter] = useState<"all" | "failed" | "files">("all");
  const [preview, setPreview] = useState<{
    fileId: string;
    path: string;
    x: number;
    y: number;
    loading: boolean;
    content: RoundFileContent | null;
  } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>();
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const requestSequence = useRef(0);
  const [now, setNow] = useState(Date.now());
  const active = round.status === "running" || round.status === "waiting";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const closePreview = () => {
    clearTimeout(hoverTimer.current);
    clearTimeout(hideTimer.current);
    requestSequence.current += 1;
    setPreview(null);
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearTimeout(hoverTimer.current);
        clearTimeout(hideTimer.current);
        requestSequence.current += 1;
        setPreview(null);
      }
    };
    const outside = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".round-hover-preview, .round-file-link")
      ) {
        requestSequence.current += 1;
        setPreview(null);
        clearTimeout(hoverTimer.current);
      }
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
      clearTimeout(hoverTimer.current);
      clearTimeout(hideTimer.current);
      requestSequence.current += 1;
    };
  }, []);
  useEffect(() => {
    closePreview();
    setFilesExpanded(false);
    setFilter("all");
  }, [round.id]);
  function enter(
    fileId: string,
    path: string,
    element: HTMLElement,
    line?: number,
  ) {
    clearTimeout(hideTimer.current);
    clearTimeout(hoverTimer.current);
    const sequence = ++requestSequence.current;
    const rect = element.getBoundingClientRect();
    hoverTimer.current = setTimeout(() => {
      const width = Math.min(720, Math.max(240, window.innerWidth - 24));
      const x = Math.max(
        12,
        Math.min(rect.left, window.innerWidth - width - 12),
      );
      const height = Math.min(420, window.innerHeight - 24);
      const y = Math.max(
        12,
        Math.min(rect.bottom + 6, window.innerHeight - height - 12),
      );
      setPreview({ fileId, path, x, y, loading: true, content: null });
      void loadFile(round.id, fileId).then(
        (content) => {
          if (requestSequence.current === sequence)
            setPreview({
              fileId,
              path,
              x,
              y,
              loading: false,
              content: content ? { ...content, targetLine: line } : null,
            });
        },
        () => {
          if (requestSequence.current === sequence)
            setPreview({ fileId, path, x, y, loading: false, content: null });
        },
      );
    }, 350);
  }
  function leave() {
    clearTimeout(hoverTimer.current);
    hideTimer.current = setTimeout(closePreview, 160);
  }
  function fileLink(id: string, path: string, line?: number) {
    return (
      <button
        type="button"
        className="round-file-link"
        title={line ? `${path} · 第 ${line} 行` : path}
        aria-label={line ? `${path} · 第 ${line} 行` : undefined}
        onMouseEnter={(event) => enter(id, path, event.currentTarget, line)}
        onMouseLeave={leave}
        onClick={() => {
          closePreview();
          onRead(round.id, id, line);
        }}
      >
        {path}
      </button>
    );
  }
  const failures = round.activities.filter(
    (item) => item.status === "failed",
  ).length;
  const succeeded = round.activities.filter(
    (item) => item.status === "succeeded",
  ).length;
  const items = round.activities.filter(
    (item) =>
      filter === "all" ||
      (filter === "failed" ? item.status === "failed" : item.files.length > 0),
  );
  const duration =
    active && round.durationMs === null
      ? Math.max(0, now - Date.parse(round.startedAt))
      : round.durationMs;
  const total = (field: "added" | "removed") =>
    round.files.some((file) => file[field] === null)
      ? "--"
      : round.files
          .reduce((sum, file) => sum + (file[field] ?? 0), 0)
          .toLocaleString();
  return (
    <section className="round-results" aria-label="本轮结果">
      <details className="round-process">
        <summary className={`round-status is-${round.status}`}>
          <span>
            {round.status === "completed" && failures
              ? "已结束 · 有失败项"
              : roundLabels[round.status]}
          </span>
          <span>用时 {roundDuration(duration)}</span>
          {failures > 0 && (
            <span className="round-failed">{failures} 项失败</span>
          )}
          <span className="round-process-hint">查看过程</span>
        </summary>
        <div className="round-process-body">
          {round.publicReasoning
            ?.filter((item) => item.text.trim())
            .map((item) => (
              <details key={item.id} className="round-public-reasoning">
                <summary>
                  {item.role === "persona" ? "黑塔" : "执行器"} ·{" "}
                  {item.format === "summary"
                    ? "思考摘要"
                    : "服务返回的思考文本"}
                </summary>
                <Output text={item.text} truncated={item.truncated} />
              </details>
            ))}
          <div className="round-filters" role="group" aria-label="工具记录筛选">
            {(
              [
                ["all", "全部"],
                ["failed", "仅失败"],
                ["files", "涉及文件"],
              ] as const
            ).map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
            <span>
              {round.activities.length} 步 · {succeeded} 成功 · {failures} 失败
            </span>
          </div>
          {items.length > 0 ? (
            <ol className="round-tools">
              {items.map((activity) => (
                <ToolRow
                  roundId={round.id}
                  loadFile={loadFile}
                  key={activity.id}
                  activity={activity}
                  fileLink={fileLink}
                />
              ))}
            </ol>
          ) : (
            <p className="round-note">
              {round.activities.length
                ? "没有符合筛选的记录。"
                : "本轮未记录工具操作。"}
            </p>
          )}
        </div>
      </details>
      {!active && (
        <>
          {round.files.length > 0 ? (
            <section className="round-files-card" aria-label="本轮修改文件">
              <header>
                <strong>本轮修改 {round.files.length} 个文件</strong>
                <span className="round-diff-stat">
                  <span className="round-added">+{total("added")}</span>
                  <span className="round-removed">−{total("removed")}</span>
                </span>
              </header>
              <ul>
                {round.files
                  .slice(0, filesExpanded ? undefined : 6)
                  .map((file) => (
                    <li key={file.id}>
                      <div className="round-file-main">
                        <span className="round-file-icon" aria-hidden="true">
                          ▤
                        </span>
                        {fileLink(file.id, file.path)}
                        <small>{changeLabels[file.kind]}</small>
                        <span className="round-diff-stat">
                          <span className="round-added">
                            +{file.added ?? "--"}
                          </span>
                          <span className="round-removed">
                            −{file.removed ?? "--"}
                          </span>
                        </span>
                      </div>
                      {file.previousPath && (
                        <small className="round-file-detail">
                          原路径：{file.previousPath}
                        </small>
                      )}
                      {file.confidence === "observed" && (
                        <small className="round-file-detail">
                          期间检测到变化，归属未确认
                        </small>
                      )}
                      {file.unavailable && (
                        <small className="round-file-detail">
                          {file.unavailable}
                        </small>
                      )}
                    </li>
                  ))}
              </ul>
              {round.files.length > 6 && (
                <button
                  className="round-expand"
                  type="button"
                  aria-expanded={filesExpanded}
                  onClick={() => setFilesExpanded(!filesExpanded)}
                >
                  {filesExpanded
                    ? "收起文件"
                    : `展开全部 ${round.files.length} 个文件`}
                </button>
              )}
            </section>
          ) : round.activities.length > 0 || round.limitations.length > 0 ? (
            <p className="round-empty-files">
              {round.limitations.length
                ? "未记录到可确认的文件变更，见下方记录限制。"
                : "本轮未修改文件"}
            </p>
          ) : null}
          {round.activities.length > 0 && (
            <details className="round-task-card" open>
              <summary>
                <strong>本轮任务结果</strong>
                <span>
                  {succeeded} 执行成功
                  {failures > 0 ? ` · ${failures} 失败` : ""}
                </span>
              </summary>
              <ul>
                {round.activities.map((item) => (
                  <li key={item.id}>
                    <span
                      className={`round-status-dot is-${item.status}`}
                      aria-hidden="true"
                    />
                    <span>
                      <small>{toolLabel(item.kind)} · </small>
                      {item.title}
                    </span>
                    <span className={`round-state is-${item.status}`}>
                      {activityLabels[item.status]}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="round-usage">
            本轮用量{" "}
            {round.metrics.totalTokens === null
              ? "--"
              : round.metrics.totalTokens.toLocaleString()}{" "}
            tokens{round.metrics.partial ? " · 记录不完整" : ""}
          </p>
        </>
      )}
      {round.limitations.length > 0 && (
        <details className="round-limitations">
          <summary>记录限制 · {round.limitations.length}</summary>
          <ul>
            {round.limitations.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </details>
      )}
      {preview &&
        createPortal(
          <section
            className="round-hover-preview"
            aria-label="文件悬停预览"
            style={{ left: preview.x, top: preview.y }}
            onMouseEnter={() => clearTimeout(hideTimer.current)}
            onMouseLeave={leave}
          >
            <header title={preview.path}>{preview.path}</header>
            {preview.loading ? (
              <p className="round-note">正在读取快照…</p>
            ) : preview.content ? (
              <RoundFileView
                key={preview.fileId}
                content={preview.content}
                preview
              />
            ) : (
              <p className="round-note">此记录没有可用的文件快照。</p>
            )}
          </section>,
          document.body,
        )}
    </section>
  );
}
