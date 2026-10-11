import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectNavigationView } from "../../shared/workbench-ipc.js";
import { ProjectSidebar, type ProjectSidebarProps } from "./ProjectSidebar.js";

function fixture(): ProjectSidebarProps {
  const view: ProjectNavigationView = {
    schemaVersion: 1,
    revision: 1,
    projects: [
      {
        projectId: "p1",
        path: "C:\\a\\same",
        name: "same",
        alias: null,
        pinned: false,
        pinOrder: 0,
        expanded: true,
        removed: false,
        permissionMode: "workspace-edit",
      },
      {
        projectId: "p2",
        path: "C:\\b\\same",
        name: "same",
        alias: null,
        pinned: true,
        pinOrder: 1,
        expanded: true,
        removed: false,
        permissionMode: "workspace-edit",
      },
    ],
    tasks: [
      {
        sessionId: "s1",
        projectId: "p1",
        pinned: false,
        pinOrder: 0,
        recycled: false,
        permissionMode: null,
      },
      {
        sessionId: "s2",
        projectId: "p2",
        pinned: true,
        pinOrder: 1,
        recycled: false,
        permissionMode: null,
      },
    ],
  };
  return {
    view,
    sessions: [
      {
        sessionId: "s1",
        title: "任务一",
        workspaceRoot: "C:\\a\\same",
        startedAt: "2026-10-04",
        lastActivityAt: "2026-10-04",
      },
      {
        sessionId: "s2",
        title: "任务二",
        workspaceRoot: "C:\\b\\same",
        startedAt: "2026-10-04",
        lastActivityAt: "2026-10-04",
      },
    ],
    activeSessionId: "s1",
    busy: false,
    onOpen: vi.fn(),
    onCreate: vi.fn(),
    onRenameTask: vi.fn(async () => undefined),
    onUpdate: vi.fn(async () => undefined),
  };
}
function menu(label: string, index = 0) {
  const summary = screen.getAllByLabelText(label)[index]!;
  fireEvent.click(summary);
  return within(summary.parentElement!);
}
describe("project sidebar pure navigation interactions", () => {
  it("opens the matching project/task menu on right click without opening a task", () => {
    const props = fixture();
    render(<ProjectSidebar {...props} />);
    const project = screen.getByTitle("C:\\a\\same");
    const projectMenu = project
      .closest(".herta-nav-project-row")!
      .querySelector("details")!;
    fireEvent.contextMenu(project);
    expect(projectMenu).toHaveAttribute("open");
    const task = screen.getByRole("button", { name: "任务一" });
    fireEvent.contextMenu(task);
    expect(projectMenu).not.toHaveAttribute("open");
    expect(
      task.closest(".herta-nav-task")!.querySelector("details"),
    ).toHaveAttribute("open");
    expect(props.onOpen).not.toHaveBeenCalled();
    expect(props.onUpdate).not.toHaveBeenCalled();
  });
  it("dismisses on outside pointer, focus change, window blur and Escape, but not inside", () => {
    render(<ProjectSidebar {...fixture()} />);
    const trigger = screen.getAllByLabelText("same项目菜单")[0]!;
    const panel = trigger.parentElement!;
    const open = () => fireEvent.click(trigger);
    open();
    fireEvent.pointerDown(within(panel).getByText("项目位置"));
    expect(panel).toHaveAttribute("open");
    fireEvent.pointerDown(document.body);
    expect(panel).not.toHaveAttribute("open");
    open();
    fireEvent.focusIn(screen.getByRole("button", { name: "任务一" }));
    expect(panel).not.toHaveAttribute("open");
    open();
    fireEvent.blur(window);
    expect(panel).not.toHaveAttribute("open");
    open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(panel).not.toHaveAttribute("open");
    expect(trigger).toHaveFocus();
  });
  it("keeps only one menu open and closes after selecting an action", async () => {
    const props = fixture();
    render(<ProjectSidebar {...props} />);
    const triggers = screen.getAllByLabelText("same项目菜单");
    fireEvent.click(triggers[0]!);
    fireEvent.click(triggers[1]!);
    expect(triggers[0]!.parentElement).not.toHaveAttribute("open");
    fireEvent.click(
      within(triggers[1]!.parentElement!).getByRole("button", {
        name: "重命名项目",
      }),
    );
    expect(triggers[1]!.parentElement).not.toHaveAttribute("open");
    expect(screen.getByRole("form", { name: "重命名" })).toBeInTheDocument();
  });
  it("offers explicit relocation with an existing-task warning and retains busy protection", async () => {
    const props = fixture();
    props.onRelocateProject = vi.fn(async () => undefined);
    const { rerender } = render(<ProjectSidebar {...props} />);
    const actions = menu("same项目菜单", 1);
    fireEvent.click(actions.getByText("项目位置"));
    expect(actions.getByText(/已有任务仍使用原目录/)).toBeInTheDocument();
    fireEvent.click(actions.getByRole("button", { name: "重新定位文件夹" }));
    await waitFor(() =>
      expect(props.onRelocateProject).toHaveBeenCalledWith("p1"),
    );
    rerender(<ProjectSidebar {...props} busy />);
    menu("same项目菜单", 1);
    expect(
      actions.getByRole("button", { name: "重新定位文件夹" }),
    ).toBeDisabled();
  });
  it("distinguishes equal names by paths and orders pinned projects without duplicating tasks", () => {
    const props = fixture();
    render(<ProjectSidebar {...props} />);
    const pinnedGroup = screen.getByRole("region", { name: "置顶项目" });
    const projectGroup = screen.getByRole("region", { name: "项目" });
    expect(
      within(pinnedGroup).getByRole("button", { name: /任务二/ }),
    ).toBeInTheDocument();
    expect(
      within(projectGroup).getByRole("button", { name: "任务一" }),
    ).toBeInTheDocument();
    expect(
      within(projectGroup).queryByRole("button", { name: /任务二/ }),
    ).not.toBeInTheDocument();
    const projects = screen
      .getAllByRole("button", { name: /same/ })
      .filter((button) => button.hasAttribute("aria-expanded"));
    expect(projects[0]).toHaveAttribute("title", "C:\\b\\same");
    expect(projects[1]).toHaveAttribute("title", "C:\\a\\same");
    expect(screen.getAllByRole("button", { name: "任务一" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "任务一" }));
    expect(props.onOpen).toHaveBeenCalledWith("s1");
    fireEvent.click(
      screen.getAllByRole("button", { name: "在same中新建任务" })[0]!,
    );
    expect(props.onCreate).toHaveBeenCalledWith({
      projectId: "p2",
      path: "C:\\b\\same",
    });
  });
  it("updates expansion and project/task pins through typed callback", async () => {
    const props = fixture();
    render(<ProjectSidebar {...props} />);
    const project = screen.getByTitle("C:\\a\\same");
    fireEvent.click(project);
    await waitFor(() =>
      expect(props.onUpdate).toHaveBeenCalledWith({
        kind: "expand-project",
        projectId: "p1",
        expanded: false,
      }),
    );
    fireEvent.click(
      menu("same项目菜单", 1).getByRole("button", { name: "置顶项目" }),
    );
    await waitFor(() =>
      expect(props.onUpdate).toHaveBeenCalledWith({
        kind: "pin-project",
        projectId: "p1",
        pinned: true,
      }),
    );
    fireEvent.click(
      menu("任务一任务菜单").getByRole("button", { name: "置顶任务" }),
    );
    await waitFor(() =>
      expect(props.onUpdate).toHaveBeenCalledWith({
        kind: "pin-task",
        sessionId: "s1",
        pinned: true,
      }),
    );
  });
  it("confirms project navigation removal with independent counted task recycling", async () => {
    const props = fixture();
    render(<ProjectSidebar {...props} />);
    fireEvent.click(
      menu("same项目菜单", 1).getByRole("button", { name: "移除项目" }),
    );
    expect(screen.getByText(/磁盘上的项目文件不会删除/)).toBeInTheDocument();
    expect(props.onUpdate).not.toHaveBeenCalled();
    const checkbox = screen.getByRole("checkbox", {
      name: "同时移除 1 个任务",
    });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    await waitFor(() =>
      expect(props.onUpdate).toHaveBeenCalledWith({
        kind: "remove-project",
        projectId: "p1",
        recycleTasks: true,
      }),
    );
  });
  it("renames a task only after explicit save", async () => {
    const props = fixture();
    render(<ProjectSidebar {...props} />);
    fireEvent.click(
      menu("任务一任务菜单").getByRole("button", { name: "重命名任务" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "新名称" }), {
      target: { value: "星图" },
    });
    expect(props.onRenameTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await waitFor(() =>
      expect(props.onRenameTask).toHaveBeenCalledWith("s1", "星图"),
    );
  });
  it("blocks destructive operations during output and keeps switching callback available", () => {
    const props = fixture();
    render(<ProjectSidebar {...props} busy />);
    expect(
      menu("任务一任务菜单").getByRole("button", { name: "移除任务" }),
    ).toBeDisabled();
    expect(
      menu("same项目菜单", 1).getByRole("button", { name: "移除项目" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /任务二/ }));
    expect(props.onOpen).toHaveBeenCalledWith("s2");
  });
  it("renames project aliases and cancels removal without mutation", async () => {
    const props = fixture();
    render(<ProjectSidebar {...props} />);
    fireEvent.click(
      menu("same项目菜单", 1).getByRole("button", { name: "重命名项目" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "新名称" }), {
      target: { value: "研究目录" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await waitFor(() =>
      expect(props.onUpdate).toHaveBeenCalledWith({
        kind: "rename-project",
        projectId: "p1",
        name: "研究目录",
      }),
    );
    // A parent render normally supplies the new alias; this pure fixture keeps its original view.
    const summary = screen.getAllByLabelText("same项目菜单")[1]!;
    fireEvent.click(
      within(summary.parentElement!).getByRole("button", { name: "移除项目" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(props.onUpdate).toHaveBeenCalledTimes(1);
  });
});

