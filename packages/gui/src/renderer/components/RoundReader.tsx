import type { RoundFileContent } from "@herta/app-server";
import {
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useRef,
} from "react";
import { sanitizedFragment } from "./FileViewer/renderers/dom-html.js";
import { highlightToHtml } from "./FileViewer/renderers/highlight.js";
import "./round-results.css";

interface CodeRow {
  text: string;
  kind: "add" | "del" | "context" | "meta";
  oldLine?: number;
  newLine?: number;
}
const PAGE_LINES = 180;
const MAX_LINE = 8000;

/** Uses the persisted differ's markers; omitted lines advance both counters. */
export function roundDiffRows(diff: string): CodeRow[] {
  const lines = diff.split("\n");
  let oldLine = 1;
  let newLine = 1;
  const start =
    lines[0]?.startsWith("--- ") && lines[1]?.startsWith("+++ ") ? 2 : 0;
  return lines.slice(start).map((line): CodeRow => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { text: line, kind: "meta" };
    }
    if (line.startsWith("\\")) {
      const omitted = /^\\ (\d+) unchanged lines omitted/.exec(line);
      if (omitted) {
        oldLine += Number(omitted[1]);
        newLine += Number(omitted[1]);
      }
      return { text: line.slice(1).trimStart(), kind: "meta" };
    }
    if (line.startsWith("+"))
      return { text: line.slice(1), kind: "add", newLine: newLine++ };
    if (line.startsWith("-"))
      return { text: line.slice(1), kind: "del", oldLine: oldLine++ };
    if (line.startsWith(" "))
      return {
        text: line.slice(1),
        kind: "context",
        oldLine: oldLine++,
        newLine: newLine++,
      };
    return { text: line, kind: "meta" };
  });
}

function highlight(text: string, language: string): ReactNode {
  const html = highlightToHtml(text, language);
  if (html === null) return text;
  function convert(node: Node, key: string): ReactNode {
    if (!(node instanceof HTMLElement) || node.tagName !== "SPAN")
      return node.textContent;
    return (
      <span
        key={key}
        className={[...node.classList]
          .filter((name) => /^hljs-[a-z][a-z0-9_-]*$/.test(name))
          .join(" ")}
      >
        {[...node.childNodes].map((child, index) =>
          convert(child, `${key}.${index}`),
        )}
      </span>
    );
  }
  return [...sanitizedFragment(html).childNodes].map((node, index) =>
    convert(node, String(index)),
  );
}

const CodeRows = memo(function CodeRows({
  rows,
  language,
  targetLine,
}: {
  rows: CodeRow[];
  language: string;
  targetLine?: number;
}) {
  return (
    <div
      className="round-code hljs"
      role="region"
      aria-label="只读代码"
      tabIndex={0}
    >
      {rows.map((row, index) => (
        <div
          className={`round-code-row is-${row.kind}${(row.newLine ?? row.oldLine) === targetLine ? " is-target-line" : ""}`}
          aria-current={
            (row.newLine ?? row.oldLine) === targetLine ? "location" : undefined
          }
          key={`${index}-${row.oldLine}-${row.newLine}`}
        >
          <span
            className="round-code-number"
            aria-label={row.oldLine ? `原行 ${row.oldLine}` : undefined}
          >
            {row.oldLine ?? ""}
          </span>
          <span
            className="round-code-number"
            aria-label={row.newLine ? `新行 ${row.newLine}` : undefined}
          >
            {row.newLine ?? ""}
          </span>
          <span className="round-code-sign">
            {row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}
          </span>
          <code>
            {row.kind === "meta"
              ? row.text
              : highlight(row.text.slice(0, MAX_LINE), language)}
            {row.text.length > MAX_LINE && row.kind !== "meta"
              ? " …〔长行仅展示前8000字符〕"
              : ""}
          </code>
        </div>
      ))}
    </div>
  );
});

function languageFor(content: RoundFileContent): string {
  if (content.language) return content.language;
  const ext = content.path.split(".").at(-1)?.toLowerCase() ?? "";
  return (
    (
      {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        py: "python",
        md: "markdown",
        ps1: "powershell",
        yml: "yaml",
        sh: "bash",
        rs: "rust",
      } as Record<string, string>
    )[ext] ?? ext
  );
}

/** Shared by the hover preview and pinned reader. Never reads the live disk. */
export function RoundFileView({
  content,
  preview = false,
}: {
  content: RoundFileContent;
  preview?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const target =
    Number.isSafeInteger(content.targetLine) && (content.targetLine ?? 0) > 0
      ? content.targetLine
      : undefined;
  const [mode, setMode] = useState<"diff" | "before" | "after">(
    target || content.sourceLabel?.includes("读取") ? "after" : "diff",
  );
  const [page, setPage] = useState(0);
  useEffect(() => {
    setMode(target || content.sourceLabel?.includes("读取") ? "after" : "diff");
    setPage(target ? Math.floor((target - 1) / PAGE_LINES) : 0);
  }, [content.roundId, content.fileId, content.sourceLabel, target]);
  const rows = useMemo(() => {
    if (mode === "diff") return content.diff ? roundDiffRows(content.diff) : [];
    const text = mode === "before" ? content.before : content.after;
    if (text === null || text === "") return [];
    return text.split("\n").map(
      (line, index): CodeRow => ({
        text: line,
        kind: "context",
        ...(mode === "before"
          ? { oldLine: index + 1 }
          : { newLine: index + 1 }),
      }),
    );
  }, [content, mode]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_LINES));
  const currentPage = Math.min(page, pages - 1);
  useEffect(() => {
    container.current
      ?.querySelector(".is-target-line")
      ?.scrollIntoView?.({ block: "center" });
  }, [target, currentPage, mode]);
  return (
    <div className="round-file-view" ref={container}>
      <div className="round-reader-modes" role="group" aria-label="阅读版本">
        {(
          [
            ["diff", "仅看变更"],
            ["after", "修改后全文"],
            ["before", "修改前全文"],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            key={value}
            aria-pressed={mode === value}
            disabled={value !== "diff" && content[value] === null}
            onClick={() => {
              setMode(value);
              setPage(0);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="round-reader-source">
        {content.sourceLabel ?? "本轮冻结快照"} · 只读
      </p>
      {target && (
        <p className="round-note">
          {target <= rows.length && mode !== "diff"
            ? `定位至第 ${target} 行`
            : `该视图未包含第 ${target} 行`}
        </p>
      )}
      {content.unavailable && (
        <p className="round-note">{content.unavailable}</p>
      )}
      {rows.length > 0 ? (
        <CodeRows
          rows={rows.slice(
            currentPage * PAGE_LINES,
            (currentPage + 1) * PAGE_LINES,
          )}
          language={languageFor(content)}
          targetLine={target}
        />
      ) : (
        <p className="round-note">
          {mode === "diff"
            ? content.diff === ""
              ? "没有文本差异"
              : "未记录可阅读的差分，请选择已保存的完整版本。"
            : "空文件"}
        </p>
      )}
      {pages > 1 && (
        <nav className="round-code-pages" aria-label="代码分页">
          <button
            type="button"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            上一段
          </button>
          <span>
            {currentPage + 1} / {pages} · 共 {rows.length} 行
          </span>
          <button
            type="button"
            disabled={currentPage === pages - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            下一段
          </button>
        </nav>
      )}
      {preview && (
        <p className="round-preview-hint">点击文件名，在右侧持续阅读</p>
      )}
    </div>
  );
}

export interface RoundReaderProps {
  content: RoundFileContent | null;
  loading: boolean;
  onClose: () => void;
}
export function RoundReader({ content, loading, onClose }: RoundReaderProps) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  return (
    <section
      className="round-reader"
      aria-label="文件阅读面板"
      aria-busy={loading}
    >
      <header className="round-reader-header">
        <div>
          <strong title={content?.path}>
            {loading ? "正在读取快照…" : (content?.path ?? "文件阅读")}
          </strong>
          <span>历史记录 · 只读</span>
        </div>
        <button
          type="button"
          aria-label="关闭文件阅读"
          onClick={onClose}
          ref={closeButton}
        >
          ×
        </button>
      </header>
      {loading ? (
        <p className="round-note" role="status">
          正在读取已保存的版本…
        </p>
      ) : content ? (
        <RoundFileView
          key={`${content.roundId}:${content.fileId}`}
          content={content}
        />
      ) : (
        <p className="round-note">此文件的历史快照不可用。</p>
      )}
    </section>
  );
}
