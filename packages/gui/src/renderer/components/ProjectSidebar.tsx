import type { SessionMetadata } from "@herta/app-server";
import { useEffect, useRef, useState } from "react";
import type {
  NavigationMutation,
  NavigationProject,
  ProjectNavigationView,
} from "../../shared/workbench-ipc.js";
import "./project-sidebar.css";

export interface ProjectSidebarProps {
  view: ProjectNavigationView;
  sessions: readonly SessionMetadata[];
  activeSessionId: string | null;
  busy: boolean;
  onOpen: (sessionId: string) => void;
  onCreate: (project: { projectId: string; path: string | null }) => void;
  onRenameTask: (sessionId: string, title: string) => Promise<unknown>;
  onUpdate: (input: NavigationMutation) => Promise<unknown>;
  onRelocateProject?: (projectId: string) => Promise<unknown>;
}
type Edit =
  | { kind: "project" | "task"; id: string; name: string }
  | { kind: "remove"; id: string; name: string; count: number };
export function ProjectSidebar({
  view,
  sessions,
  activeSessionId,
  busy,
  onOpen,
  onCreate,
  onRenameTask,
  onUpdate,
  onRelocateProject,
}: ProjectSidebarProps) {
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = navigation.current;
    if (!root) return;
    const close = (except?: Element | null) => {
      for (const menu of root.querySelectorAll<HTMLDetailsElement>(
        ".herta-nav-actions[open]",
      )) {
        if (menu !== except) menu.open = false;
      }
    };
    const outside = (event: Event) => {
      const target = event.target;
      close(
        target instanceof Element ? target.closest(".herta-nav-actions") : null,
      );
    };
    const blur = () => close();
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const menu = root.querySelector<HTMLDetailsElement>(
        ".herta-nav-actions[open]",
      );
      if (!menu) return;
      event.preventDefault();
      close();
      menu.querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    document.addEventListener("keydown", dismissOnEscape);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      document.removeEventListener("keydown", dismissOnEscape);
      window.removeEventListener("blur", blur);
    };
  }, []);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [name, setName] = useState("");
  const [recycle, setRecycle] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const locked = busy || pending;
  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError(false);
    try {
      await action();
      setEdit(null);
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  };
  const update = (input: NavigationMutation) => {
    void run(() => onUpdate(input));
  };
  const beginRename = (kind: "project" | "task", id: string, value: string) => {
    setEdit({ kind, id, name: value });
    setName(value);
    setError(false);
  };
  const taskName = (sessionId: string) => {
    const session = sessions.find((s) => s.sessionId === sessionId);
    return session?.title || session?.lastUserText || "未命名任务";
  };
  const projects = [...view.projects].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || a.pinOrder - b.pinOrder,
  );
  const taskList = (project: NavigationProject) =>
    [...view.tasks]
      .filter((t) => t.projectId === project.projectId && !t.recycled)
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) || a.pinOrder - b.pinOrder,
      );
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegated cleanup handles clicks from native keyboard-accessible buttons and summaries.
    <nav
      className="herta-project-sidebar"
      aria-label="项目与任务"
      ref={navigation}
      onContextMenu={(event) => {
        const row = (event.target as Element).closest(
          ".herta-nav-project-row, .herta-nav-task",
        );
        const menu =
          row?.querySelector<HTMLDetailsElement>(".herta-nav-actions");
        if (!menu) return;
        event.preventDefault();
        for (const other of navigation.current?.querySelectorAll<HTMLDetailsElement>(
          ".herta-nav-actions[open]",
        ) ?? []) {
          if (other !== menu) other.open = false;
        }
        menu.open = true;
        menu.querySelector<HTMLElement>("summary")?.focus();
      }}
      onClick={(event) => {
        const trigger = (event.target as Element).closest(
          ".herta-nav-actions > summary",
        );
        if (trigger) {
          for (const other of navigation.current?.querySelectorAll<HTMLDetailsElement>(
            ".herta-nav-actions[open]",
          ) ?? []) {
            if (other !== trigger.parentElement) other.open = false;
          }
        }
        const action = (event.target as Element).closest(
          ".herta-nav-menu button",
        );
        const menu = action?.closest<HTMLDetailsElement>(".herta-nav-actions");
        if (menu && !(action as HTMLButtonElement).disabled) menu.open = false;
      }}
    >
      {[true, false].map((pinned) => {
        const group = projects.filter((p) => !p.removed && p.pinned === pinned);
        if (group.length === 0) return null;
        return (
          <section
            className="herta-nav-group"
            key={String(pinned)}
            aria-label={pinned ? "置顶项目" : "项目"}
          >
            <h2 className="herta-nav-group-label">
              {pinned ? "置顶" : "项目"}
            </h2>
            {group.map((project) => (
              <section key={project.projectId} className="herta-nav-project">
                <div className="herta-nav-project-row">
                  <button
                    type="button"
                    className="herta-nav-project-title"
                    aria-expanded={project.expanded}
                    title={project.path || "临时工作区"}
                    onClick={() =>
                      update({
                        kind: "expand-project",
                        projectId: project.projectId,
                        expanded: !project.expanded,
                      })
                    }
                    disabled={pending}
                  >
                    <svg
                      className="herta-nav-folder"
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
                      <path d="M3 8h18" />
                    </svg>
                    <span className="herta-nav-label">
                      {project.alias || project.name}
                    </span>
                    <span className="herta-nav-chevron" aria-hidden="true">
                      {project.expanded ? "⌄" : "›"}
                    </span>
                    {project.pinned && (
                      <span
                        className="herta-nav-pin"
                        role="img"
                        aria-label="已置顶"
                      >
                        ◆
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="herta-nav-new"
                    aria-label={`在${project.alias || project.name}中新建任务`}
                    onClick={() =>
                      onCreate({
                        projectId: project.projectId,
                        path: project.path,
                      })
                    }
                    disabled={locked}
                  >
                    ＋
                  </button>
                  <details className="herta-nav-actions">
                    <summary
                      aria-label={`${project.alias || project.name}项目菜单`}
                    >
                      ···
                    </summary>
                    <div className="herta-nav-menu">
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          update({
                            kind: "pin-project",
                            projectId: project.projectId,
                            pinned: !project.pinned,
                          })
                        }
                      >
                        {project.pinned ? "取消项目置顶" : "置顶项目"}
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          beginRename(
                            "project",
                            project.projectId,
                            project.alias || project.name,
                          )
                        }
                      >
                        重命名项目
                      </button>
                      <details className="herta-nav-path">
                        <summary>项目位置</summary>
                        <span>{project.path || "临时工作区 · 无项目目录"}</span>
                        {project.path !== null && onRelocateProject && (
                          <>
                            <p className="herta-nav-hint">
                              重新定位仅更新导航和新任务目录，已有任务仍使用原目录。
                            </p>
                            <button
                              type="button"
                              disabled={locked}
                              onClick={() =>
                                void run(() =>
                                  onRelocateProject(project.projectId),
                                )
                              }
                            >
                              重新定位文件夹
                            </button>
                          </>
                        )}
                      </details>
                      <button
                        type="button"
                        disabled={locked}
                        title={busy ? "先停止当前任务，再移除项目" : undefined}
                        onClick={() => {
                          setEdit({
                            kind: "remove",
                            id: project.projectId,
                            name: project.alias || project.name,
                            count: taskList(project).length,
                          });
                          setRecycle(false);
                          setError(false);
                        }}
                      >
                        移除项目
                      </button>
                    </div>
                  </details>
                </div>
                {project.expanded && (
                  <div className="herta-nav-tasks">
                    {taskList(project).map((task) => (
                      <div
                        className={`herta-nav-task${activeSessionId === task.sessionId ? " is-active" : ""}`}
                        key={task.sessionId}
                      >
                        <button
                          type="button"
                          className="herta-nav-task-title"
                          aria-current={
                            activeSessionId === task.sessionId
                              ? "page"
                              : undefined
                          }
                          title={taskName(task.sessionId)}
                          onClick={() => onOpen(task.sessionId)}
                          disabled={pending}
                        >
                          {task.pinned && (
                            <span
                              className="herta-nav-pin"
                              role="img"
                              aria-label="已置顶"
                            >
                              ◆
                            </span>
                          )}
                          <span>{taskName(task.sessionId)}</span>
                        </button>
                        <details className="herta-nav-actions">
                          <summary
                            aria-label={`${taskName(task.sessionId)}任务菜单`}
                          >
                            ···
                          </summary>
                          <div className="herta-nav-menu">
                            <button
                              type="button"
                              disabled={pending}
                              onClick={() =>
                                update({
                                  kind: "pin-task",
                                  sessionId: task.sessionId,
                                  pinned: !task.pinned,
                                })
                              }
                            >
                              {task.pinned ? "取消任务置顶" : "置顶任务"}
                            </button>
                            <button
                              type="button"
                              disabled={pending}
                              onClick={() =>
                                beginRename(
                                  "task",
                                  task.sessionId,
                                  taskName(task.sessionId),
                                )
                              }
                            >
                              重命名任务
                            </button>
                            <button
                              type="button"
                              disabled={locked}
                              title={
                                busy
                                  ? "先停止当前任务，再移除任务"
                                  : undefined
                              }
                              onClick={() =>
                                update({
                                  kind: "recycle-task",
                                  sessionId: task.sessionId,
                                })
                              }
                            >
                              移除任务
                            </button>
                          </div>
                        </details>
                      </div>
                    ))}
                    {taskList(project).length === 0 && (
                      <p className="herta-nav-empty">暂无任务</p>
                    )}
                  </div>
                )}
              </section>
            ))}
          </section>
        );
      })}
      {projects.filter((p) => !p.removed).length === 0 && (
        <p className="herta-nav-empty">打开项目或创建新任务以开始。</p>
      )}
      {busy && (
        <p className="herta-nav-hint">停止当前任务后可移除记录。</p>
      )}
      {edit && (
        <form
          className="herta-nav-edit"
          aria-label={edit.kind === "remove" ? "确认移除项目" : "重命名"}
          onSubmit={(event) => {
            event.preventDefault();
            if (edit.kind === "remove") {
              if (!locked)
                update({
                  kind: "remove-project",
                  projectId: edit.id,
                  recycleTasks: recycle,
                });
            } else if (name.trim()) {
              if (edit.kind === "project")
                update({
                  kind: "rename-project",
                  projectId: edit.id,
                  name: name.trim(),
                });
              else void run(() => onRenameTask(edit.id, name.trim()));
            }
          }}
        >
          {edit.kind === "remove" ? (
            <>
              <p>移除「{edit.name}」的导航。磁盘上的项目文件不会删除。</p>
              <label className="herta-nav-checkbox">
                <input
                  type="checkbox"
                  checked={recycle}
                  onChange={(e) => setRecycle(e.target.checked)}
                  disabled={locked}
                />
                <span>同时移除 {edit.count} 个任务</span>
              </label>
              <p className="herta-nav-hint">移除后不再显示；项目中的磁盘文件保留。</p>
            </>
          ) : (
            <label>
              新名称
              <input
                type="text"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                disabled={pending}
              />
            </label>
          )}
          <div className="herta-nav-edit-actions">
            <button
              type="submit"
              disabled={
                edit.kind === "remove" ? locked : pending || !name.trim()
              }
            >
              {edit.kind === "remove" ? "确认移除" : "保存名称"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setEdit(null)}
            >
              取消
            </button>
          </div>
        </form>
      )}
      {error && <p role="alert">操作未完成，记录已保留，请重试。</p>}
    </nav>
  );
}
