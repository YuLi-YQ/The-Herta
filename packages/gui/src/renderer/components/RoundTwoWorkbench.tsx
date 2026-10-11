import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useHertaBridge } from "../context/HertaBridgeContext.js";
import { SettingsModal } from "./Settings/SettingsModal.js";

type View = "welcome" | "chat" | "approval" | "diff";
type Approval =
  | "等待批准"
  | "演示：已允许本次"
  | "演示：已拒绝"
  | "演示：已过期";
const DEMO_NOTICE = "界面演示 · 不调用模型，不执行工具，不修改文件";

/** Isolated examples never write to the real session store or invoke execution IPC. */
export function DemoPanel({
  view,
}: {
  readonly view: Exclude<View, "welcome">;
}): JSX.Element {
  const [approval, setApproval] = useState<Approval>("等待批准");
  const [retry, setRetry] = useState(false);
  const [file, setFile] = useState("text");
  return (
    <section className="herta-demo" aria-label="界面演示">
      <p className="herta-demo-notice">{DEMO_NOTICE}</p>
      {view === "chat" && (
        <>
          <article className="herta-user">
            <strong>你 · 演示消息</strong>
            <p>请检查这个项目的中文路径与错误处理，给出可读的修改建议。</p>
          </article>
          <article>
            <strong>The Herta · 演示消息</strong>
            <p>
              先明确边界，再让每一项变化都有依据。以下是固定展示内容，并非模型输出。
            </p>
            <p>{"长中文内容用于检查窗口换行、文本选择和滚动。".repeat(18)}</p>
            <details>
              <summary>代码建议 · 演示 · 可展开</summary>
              <pre>
                <code>
                  {
                    'export function resolveProject(path: string) {\n  if (!path.trim()) throw new Error("请选择项目文件夹");\n  return path;\n}\n'
                  }
                </code>
              </pre>
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard.writeText(
                    "export function resolveProject(path: string) { return path; }",
                  )
                }
              >
                复制示例代码
              </button>
            </details>
          </article>
          <details>
            <summary>工具活动 · 演示失败 · 未执行</summary>
            <p>
              命令：pnpm test
              <br />
              工作目录：C:\\示例项目\\黑塔实验室
              <br />
              结果：演示连接中断，未执行任何命令。
            </p>
            <button type="button" onClick={() => setRetry(true)}>
              重试样例展示
            </button>
            {retry && (
              <p role="status">演示重试：仍未执行。真实重试将在第三轮接线。</p>
            )}
          </details>
        </>
      )}
      {view === "approval" && (
        <article className="herta-approval" aria-labelledby="approval-title">
          <h2 id="approval-title" tabIndex={-1}>
            审批示例 · {approval}
          </h2>
          <dl>
            <dt>待执行动作</dt>
            <dd>运行 pnpm test（演示）</dd>
            <dt>工作目录</dt>
            <dd>C:\\示例项目\\黑塔实验室</dd>
            <dt>权限原因</dt>
            <dd>命令可能启动子进程。此处仅展示审批状态。</dd>
            <dt>运行标识</dt>
            <dd>demo-run-001 / request-001</dd>
          </dl>
          <div className="herta-actions">
            <button
              type="button"
              disabled={approval !== "等待批准"}
              onClick={() => setApproval("演示：已允许本次")}
            >
              允许本次（演示）
            </button>
            <button
              type="button"
              disabled={approval !== "等待批准"}
              onClick={() => setApproval("演示：已拒绝")}
            >
              拒绝（演示）
            </button>
            <button
              type="button"
              disabled={approval !== "等待批准"}
              onClick={() => setApproval("演示：已过期")}
            >
              展示过期
            </button>
            <button type="button" onClick={() => setApproval("等待批准")}>
              重置样例
            </button>
          </div>
          <p role="status">{approval} · 不构成真实授权，没有执行副作用。</p>
        </article>
      )}
      {view === "diff" && (
        <article>
          <h2>只读变更审阅 · 演示</h2>
          <p>版本 demo-v1 · 固定样例，无真实磁盘差异</p>
          <div className="herta-actions">
            {[
              ["text", "src/project.ts · 修改"],
              ["binary", "assets/logo.png · 二进制"],
              ["large", "logs/output.txt · 超大文件"],
              ["empty", "src/empty.ts · 空文件"],
              ["same", "src/same.ts · 无差异"],
              ["error", "src/unreadable.ts · 读取失败"],
            ].map(([id, label]) => (
              <button
                type="button"
                key={id}
                aria-pressed={file === id}
                onClick={() => setFile(id ?? "text")}
              >
                {label}
              </button>
            ))}
          </div>
          {file === "text" ? (
            <pre className="herta-diff">
              <code>
                <span className="herta-removed">- return path.trim();</span>
                {"\n"}
                <span className="herta-added">
                  + if (!path.trim()) throw new Error("请选择项目文件夹");
                </span>
                {"\n"}
                <span className="herta-added">+ return path;</span>
              </code>
            </pre>
          ) : (
            <p role="status">
              {
                {
                  binary: "二进制内容无法显示文本 diff。",
                  large: "超大文件样例：不载入全部内容。",
                  empty: "该文件为空。",
                  same: "样例文件没有差异。",
                  error: "演示读取失败：没有文件读取权限。",
                }[file]
              }
            </p>
          )}
          <p>只读视图不提供应用补丁、回滚或提交功能。</p>
        </article>
      )}
    </section>
  );
}

function readLocal(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function RoundTwoWorkbench(): JSX.Element {
  const { bridge } = useHertaBridge();
  const initial = new URLSearchParams(window.location.search).get("demo");
  const [view, setView] = useState<View>(
    initial === "chat" || initial === "approval" || initial === "diff"
      ? initial
      : "welcome",
  );
  const [settings, setSettings] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [draft, setDraft] = useState(() => readLocal("the-herta.draft.v1"));
  const [error, setError] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    Math.max(
      200,
      Math.min(300, Number(readLocal("the-herta.sidebar.v1")) || 240),
    ),
  );
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    try {
      localStorage.setItem("the-herta.draft.v1", draft);
    } catch {
      setError(
        "草稿保存失败。请复制当前文本后再退出，当前输入仍保留在窗口内。",
      );
    }
  }, [draft]);
  useEffect(() => {
    try {
      localStorage.setItem("the-herta.sidebar.v1", String(sidebarWidth));
    } catch {
      setError("布局保存失败，当前布局仍可使用。");
    }
  }, [sidebarWidth]);
  useEffect(() => bridge.onOpenSettings?.(() => setSettings(true)), [bridge]);
  const openProject = useCallback(async (): Promise<void> => {
    setError("");
    try {
      const path = await bridge.pickWorkspace();
      if (path) {
        setWorkspace(path);
        setView("welcome");
      }
    } catch {
      setError("无法打开文件夹选择器，请重试。未更改项目。");
    }
  }, [bridge]);
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.isComposing) return;
      if (e.key === ",") {
        e.preventDefault();
        setSettings(true);
      }
      if (e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openProject();
      }
      if (e.key.toLowerCase() === "l") {
        e.preventDefault();
        input.current?.focus({ preventScroll: true });
      }
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        setView("welcome");
        input.current?.focus({ preventScroll: true });
      }
      if (e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setCollapsed((v) => !v);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [openProject]);
  return (
    <div
      className={`herta-shell${collapsed ? " herta-focused" : ""}`}
      style={{ "--herta-sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <header className="herta-title">
        <span className="herta-star" aria-hidden="true">
          ✦
        </span>
        <strong>The Herta</strong>
        <span>桌面编程工作台</span>
      </header>
      <aside className="herta-sidebar" aria-label="项目与任务导航">
        <button
          type="button"
          onClick={() => {
            setView("welcome");
            input.current?.focus({ preventScroll: true });
          }}
        >
          ＋ 新任务草稿
        </button>
        <h2>项目</h2>
        <button type="button" onClick={() => void openProject()}>
          打开项目文件夹
        </button>
        <p className="herta-path" title={workspace}>
          {workspace || "尚未选择项目"}
        </p>
        {workspace && (
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(workspace)}
          >
            复制项目路径
          </button>
        )}
        <h2>任务</h2>
        <p>
          尚无已接入的新 Provider 任务。旧会话记录保留在原数据目录，第三轮接入。
        </p>
        <details>
          <summary>界面演示（不调用模型、不执行工具）</summary>
          <button type="button" onClick={() => setView("chat")}>
            聊天与工具样例
          </button>
          <button type="button" onClick={() => setView("approval")}>
            审批样例
          </button>
          <button type="button" onClick={() => setView("diff")}>
            只读变更样例
          </button>
        </details>
        <button
          type="button"
          className="herta-settings-button"
          onClick={() => setSettings(true)}
        >
          设置 · 连接与模型
        </button>
      </aside>
      {/* biome-ignore lint/a11y/useSemanticElements: adjustable vertical splitter requires keyboard and pointer interaction. */}
      <div
        className="herta-resizer"
        role="separator"
        aria-label="导航宽度"
        aria-orientation="vertical"
        aria-valuenow={sidebarWidth}
        aria-valuemin={200}
        aria-valuemax={300}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            setSidebarWidth((v) =>
              Math.max(
                200,
                Math.min(300, v + (e.key === "ArrowLeft" ? -10 : 10)),
              ),
            );
          }
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            setSidebarWidth(Math.max(200, Math.min(300, e.clientX)));
        }}
        onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
      />
      <main className="herta-main">
        <div className="herta-toolbar">
          <button
            type="button"
            aria-label={collapsed ? "展开导航" : "收起导航"}
            onClick={() => setCollapsed((v) => !v)}
          >
            ☰
          </button>
          <span>{view === "welcome" ? "新任务草稿" : "界面演示"}</span>
          <span className="herta-status">第三轮接入模型请求</span>
          <button type="button" onClick={() => setView("welcome")}>
            返回工作台
          </button>
        </div>
        <div className="herta-content">
          {view === "welcome" ? (
            <section className="herta-welcome">
              <span className="herta-star" aria-hidden="true">
                ✦
              </span>
              <p className="herta-eyebrow">THE HERTA / WORKBENCH</p>
              <h1>让每一项变化，都有依据。</h1>
              <p>打开项目，留下问题。下一轮将接入真实模型与执行流程。</p>
              <div className="herta-actions">
                <button
                  className="herta-primary"
                  type="button"
                  onClick={() => void openProject()}
                >
                  打开项目文件夹
                </button>
                <button type="button" onClick={() => setSettings(true)}>
                  配置 Provider
                </button>
              </div>
              <p>第二轮 · 配置可保存；模型请求、工具执行与审批尚未接线。</p>
              {workspace && (
                <p>
                  已选择项目：<span className="herta-path">{workspace}</span> ·
                  本轮仅用于草稿，不启动服务。
                </p>
              )}
              <details>
                <summary>界面演示（不调用模型、不执行工具）</summary>
                <div className="herta-actions">
                  <button type="button" onClick={() => setView("chat")}>
                    聊天
                  </button>
                  <button type="button" onClick={() => setView("approval")}>
                    审批
                  </button>
                  <button type="button" onClick={() => setView("diff")}>
                    只读 diff
                  </button>
                </div>
              </details>
            </section>
          ) : (
            <DemoPanel key={view} view={view} />
          )}
          {error && (
            <p role="alert" className="herta-error">
              {error}
            </p>
          )}
        </div>
        <footer className="herta-composer">
          <label htmlFor="herta-draft">任务草稿 · 保存在本机，尚未发送</label>
          <textarea
            id="herta-draft"
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="描述你希望处理的问题… 支持中文和多行输入"
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing)
                return; /* No send action exists before real adapters are connected. */
            }}
          />
          <div>
            <span>Provider 请求将在第三轮接入，当前不能发送。</span>
            <button type="button" disabled title="第三轮接入真实请求后启用">
              发送（未接线）
            </button>
          </div>
        </footer>
      </main>
      <SettingsModal open={settings} onClose={() => setSettings(false)} />
    </div>
  );
}
