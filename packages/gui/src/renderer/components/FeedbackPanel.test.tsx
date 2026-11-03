import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  bridge: {} as Record<string, unknown>,
}));
vi.mock("../context/HertaBridgeContext.js", () => ({
  useHertaBridge: () => ({ bridge: mock.bridge }),
}));

import {
  buildFeedbackMarkdown,
  describeSystem,
  type FeedbackContext,
  type FeedbackEnvironment,
  FeedbackPanel,
  type FeedbackRequest,
  maskUserPaths,
} from "./FeedbackPanel.js";

const environment: FeedbackEnvironment = {
  version: "0.8.10",
  system: { platform: "win32", release: "10.0.26200", arch: "x64" },
  theme: "dark",
  appearance: "observatory",
  motion: "system",
  reducedMotion: true,
  language: "follow",
};
const failing: FeedbackContext = {
  scope: "workbench",
  error: "服务限流，请稍后再试。\n第二行",
  failure: [
    { label: "代码", value: "rate-limit" },
    { label: "阶段", value: "request" },
    { label: "HTTP 状态", value: "429" },
  ],
  settings: [
    { label: "权限档位", value: "工作区编辑" },
    { label: "黑塔模型", value: "deepseek-chat · 深度" },
  ],
};
const at = { now: new Date("2026-10-30T12:00:00Z"), timeZone: "Asia/Tokyo" };
const ENVIRONMENT = [
  "## 环境",
  "",
  "- 应用版本：0.8.10",
  "- 系统：Windows 11（10.0.26200）· x64",
  "- 界面主题：深紫 · 星间书房",
  "- 界面风格：星间书房",
  "- 界面动效：跟随系统 · 轻量动效（系统已开启“减少动态效果”）",
  "- 对话语言：跟随界面语言",
].join("\n");
const ENDING =
  "---\n\n*未自动附带密钥与令牌、聊天与任务内容、附件与文件内容；路径中的用户名已替换为 <用户>，疑似密钥在保存时遮蔽。*\n";

describe("the feedback Markdown (R125)", () => {
  it("has the description and what the panel adds by itself, and no diagnostic unless chosen", () => {
    expect(
      buildFeedbackMarkdown(
        {
          description: "  发送后卡住，C:\\Users\\ExampleUser\\proj 里的文件没读到\n",
          context: failing,
          environment,
          include: new Set(),
        },
        at,
      ),
    ).toBe(
      [
        "# The Herta 反馈",
        "写于 2026-10-30 21:00 · 工作台",
        "## 问题描述",
        "发送后卡住，C:\\Users\\<用户>\\proj 里的文件没读到",
        ENVIRONMENT,
        ENDING,
      ].join("\n\n"),
    );
  });
  it("adds the chosen diagnostics only, in the panel's order", () => {
    const markdown = buildFeedbackMarkdown(
      {
        description: "限流",
        context: { ...failing, scope: "chat" },
        environment: {
          ...environment,
          version: null,
          system: null,
          reducedMotion: false,
          language: null,
        },
        include: new Set(["settings", "error"]),
      },
      at,
    );
    expect(markdown).toContain("写于 2026-10-30 21:00 · 黑塔聊天");
    expect(markdown).toContain("- 应用版本：未知\n- 系统：未知");
    expect(markdown).toContain(
      "- 界面动效：跟随系统 · 轻量动效\n- 对话语言：未知",
    );
    expect(markdown).toContain(
      [
        "## 诊断",
        "### 错误提示",
        "> 服务限流，请稍后再试。\n> 第二行",
        "### 设置概要",
        "- 权限档位：工作区编辑\n- 黑塔模型：deepseek-chat · 深度",
        ENDING,
      ].join("\n\n"),
    );
    expect(markdown).not.toContain("最近一次失败");
    expect(markdown).not.toContain("rate-limit");
  });
  it("puts <用户> for the user name in a profile path and leaves other paths alone", () => {
    const cases: [string, string][] = [
      [
        "C:\\Users\\ExampleUser\\Documents\\a.txt",
        "C:\\Users\\<用户>\\Documents\\a.txt",
      ],
      ["c:/users/ExampleUser/x", "c:/users/<用户>/x"],
      ["C:\\\\Users\\\\ExampleUser\\\\AppData", "C:\\\\Users\\\\<用户>\\\\AppData"],
      ["C:\\Users\\Ann Lee\\Desktop\\x", "C:\\Users\\<用户>\\Desktop\\x"],
      ["打开C:\\Users\\张三\\桌面失败", "打开C:\\Users\\<用户>\\桌面失败"],
      ["目录是 C:\\Users\\ExampleUser，打不开", "目录是 C:\\Users\\<用户>，打不开"],
      ["在 C:\\Users\\ExampleUser 下", "在 C:\\Users\\<用户> 下"],
      [
        "D:\\Documents and Settings\\bob\\x",
        "D:\\Documents and Settings\\<用户>\\x",
      ],
      [
        "见 /home/rainy/project 与 /Users/ann/x",
        "见 /home/<用户>/project 与 /Users/<用户>/x",
      ],
      ["/mnt/c/Users/ExampleUser/x", "/mnt/c/Users/<用户>/x"],
      // A name run straight into the sentence is masked to the next space or punctuation.
      ["C:\\Users\\ExampleUser打不开", "C:\\Users\\<用户>"],
      // Not a profile path.
      ["https://example.com/Users/abc", "https://example.com/Users/abc"],
      ["src/Users/list.ts", "src/Users/list.ts"],
      ["C:\\Program Files\\Herta", "C:\\Program Files\\Herta"],
    ];
    for (const [input, masked] of cases) {
      expect(maskUserPaths(input)).toBe(masked);
      expect(maskUserPaths(masked)).toBe(masked);
    }
  });
  it("names Windows 11 by its build number", () => {
    expect(describeSystem(environment.system)).toBe(
      "Windows 11（10.0.26200）· x64",
    );
    expect(
      describeSystem({ platform: "win32", release: "10.0.19045", arch: "x64" }),
    ).toBe("Windows 10（10.0.19045）· x64");
    expect(
      describeSystem({ platform: "win32", release: "6.3.9600", arch: "ia32" }),
    ).toBe("Windows（6.3.9600）· ia32");
    expect(
      describeSystem({ platform: "darwin", release: "24.0.0", arch: "arm64" }),
    ).toBe("darwin（24.0.0）· arm64");
    expect(describeSystem(null)).toBe("未知");
  });
});

/** A composer stand-in: its button runs `/feedback` the way both menus do. */
function Host({
  context,
  shown = true,
}: {
  readonly context: FeedbackContext;
  readonly shown?: boolean;
}) {
  const [request, setRequest] = useState<FeedbackRequest | null>(null);
  return (
    <>
      <button
        type="button"
        onClick={() =>
          setRequest((r) => ({ nonce: (r?.nonce ?? 0) + 1, context }))
        }
      >
        打开
      </button>
      <FeedbackPanel request={request} shown={shown} />
    </>
  );
}
const open = () => {
  const opener = screen.getByRole("button", { name: "打开" });
  opener.focus();
  fireEvent.click(opener);
  return opener;
};
const describeBox = () => screen.getByRole("textbox", { name: /问题描述/ });
const previewText = () =>
  (screen.getByRole("textbox", { name: /预览/ }) as HTMLTextAreaElement).value;
const save = () => mock.bridge.saveSessionExport as ReturnType<typeof vi.fn>;

describe("the feedback panel (R125)", () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
    mock.bridge = {
      saveSessionExport: vi.fn(async () => ({ saved: true })),
      getAppVersion: vi.fn(async () => "0.8.10"),
      getSystemInfo: vi.fn(async () => environment.system),
      getInteractionLanguage: vi.fn(async () => "zh"),
    };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes no diagnostic unless checked, shows what each adds, and waits for a description", async () => {
    render(
      <Host
        context={{
          scope: "workbench",
          error: "打不开 C:\\Users\\ExampleUser\\proj\\a.txt",
          failure: null,
          settings: [{ label: "权限档位", value: "工作区编辑" }],
        }}
      />,
    );
    open();
    expect(
      await screen.findByText("系统：Windows 11（10.0.26200）· x64"),
    ).toBeInTheDocument();
    expect(describeBox()).toHaveFocus();
    expect(screen.getByText("对话语言：中文")).toBeInTheDocument();
    const error = screen.getByRole("checkbox", { name: "错误提示" });
    expect(error).not.toBeChecked();
    expect(error).toHaveAccessibleDescription(
      "打不开 C:\\Users\\<用户>\\proj\\a.txt",
    );
    const failure = screen.getByRole("checkbox", { name: "最近一次失败" });
    expect(failure).toBeDisabled();
    expect(failure).toHaveAccessibleDescription("没有记录到失败");
    expect(
      screen.getByRole("checkbox", { name: "设置概要" }),
    ).not.toBeChecked();
    const preview = screen.getByRole("button", { name: "预览" });
    expect(preview).toBeDisabled();
    fireEvent.change(describeBox(), { target: { value: "  \n" } });
    expect(preview).toBeDisabled();
    fireEvent.change(describeBox(), { target: { value: "导出后文件是空的" } });
    fireEvent.click(preview);
    const plain = previewText();
    expect(plain).toContain("## 问题描述\n\n导出后文件是空的");
    expect(plain).toContain("- 应用版本：0.8.10");
    expect(plain).not.toContain("## 诊断");
    expect(plain).not.toContain("打不开");
    expect(plain).not.toContain("工作区编辑");
    // Only what is checked goes in.
    fireEvent.click(screen.getByRole("button", { name: "返回修改" }));
    expect(describeBox()).toHaveFocus();
    fireEvent.click(screen.getByRole("checkbox", { name: "错误提示" }));
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    const chosen = previewText();
    expect(chosen).toContain(
      "### 错误提示\n\n> 打不开 C:\\Users\\<用户>\\proj\\a.txt",
    );
    expect(chosen).not.toContain("设置概要");
    expect(chosen).not.toContain("ExampleUser");
    expect(save()).not.toHaveBeenCalled();
  });

  it("saves the preview as edited, masking user names in paths again, and starts afresh after a save", async () => {
    render(<Host context={failing} />);
    const opener = open();
    await screen.findByText("应用版本：0.8.10");
    fireEvent.change(describeBox(), {
      target: { value: "C:\\Users\\ExampleUser\\x 打不开" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "最近一次失败" }));
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(screen.getByRole("textbox", { name: /预览/ })).toHaveFocus();
    fireEvent.change(screen.getByRole("textbox", { name: /预览/ }), {
      target: { value: `${previewText()}\n补充：D:\\Users\\Bob\\y` },
    });
    expect(
      screen.getByText("返回修改会放弃对预览的修改。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存…" }));
    expect(await screen.findByText("已保存。")).toHaveAttribute(
      "role",
      "status",
    );
    expect(save()).toHaveBeenCalledTimes(1);
    const [name, text] = save().mock.calls[0]! as [string, string];
    expect(name).toMatch(/^The Herta 反馈 \d{4}-\d{2}-\d{2}$/);
    expect(text).toContain("C:\\Users\\<用户>\\x 打不开");
    expect(text).toContain(
      "- 代码：rate-limit\n- 阶段：request\n- HTTP 状态：429",
    );
    expect(text).toContain("补充：D:\\Users\\<用户>\\y");
    expect(text).not.toMatch(/ExampleUser|Bob/);
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(screen.queryByRole("textbox", { name: /问题描述/ })).toBeNull();
    expect(opener).toHaveFocus();
    open();
    expect(
      await screen.findByRole("textbox", { name: /问题描述/ }),
    ).toHaveValue("");
    expect(
      screen.getByRole("checkbox", { name: "最近一次失败" }),
    ).not.toBeChecked();
  });

  it("says nothing when the save is cancelled, and says a failed or broken save kept the feedback", async () => {
    save()
      .mockResolvedValueOnce({ saved: false })
      .mockResolvedValueOnce({ saved: false, failed: true })
      .mockRejectedValueOnce(new Error("ipc"));
    render(<Host context={failing} />);
    open();
    await screen.findByText("应用版本：0.8.10");
    fireEvent.change(describeBox(), { target: { value: "保存失败的情况" } });
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    const failed = "保存没有完成，反馈仍在这里，可以重试。";
    const saveOnce = async (calls: number) => {
      fireEvent.click(screen.getByRole("button", { name: "保存…" }));
      // A new attempt clears what the last one said.
      expect(screen.queryByText(failed)).toBeNull();
      await act(async () => {});
      expect(save()).toHaveBeenCalledTimes(calls);
    };
    await saveOnce(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("已保存。")).toBeNull();
    expect(previewText()).toContain("保存失败的情况");
    await saveOnce(2);
    expect(screen.getByText(failed)).toHaveAttribute("role", "alert");
    await saveOnce(3);
    expect(screen.getByText(failed)).toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "保存…" })).toBeEnabled();
  });

  it("keeps what was written when closed, gives focus back, and closes when its host hides", async () => {
    const { rerender } = render(<Host context={failing} />);
    const opener = open();
    await screen.findByText("应用版本：0.8.10");
    fireEvent.change(describeBox(), { target: { value: "写了一半" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "设置概要" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭反馈" }));
    expect(screen.queryByRole("textbox", { name: /问题描述/ })).toBeNull();
    expect(opener).toHaveFocus();
    open();
    expect(
      await screen.findByRole("textbox", { name: /问题描述/ }),
    ).toHaveValue("写了一半");
    expect(screen.getByRole("checkbox", { name: "设置概要" })).toBeChecked();
    // A diagnostic the composer no longer has drops out.
    fireEvent.click(screen.getByRole("button", { name: "关闭反馈" }));
    rerender(<Host context={{ ...failing, settings: [] }} />);
    open();
    expect(
      await screen.findByRole("checkbox", { name: "设置概要" }),
    ).not.toBeChecked();
    rerender(<Host context={{ ...failing, settings: [] }} shown={false} />);
    expect(screen.queryByRole("textbox", { name: /问题描述/ })).toBeNull();
    expect(save()).not.toHaveBeenCalled();
  });

  it("writes 未知 for what it cannot read, waiting 2 s at most", async () => {
    vi.useFakeTimers();
    mock.bridge = {
      saveSessionExport: vi.fn(async () => ({ saved: true })),
      getAppVersion: vi.fn(async () => {
        throw new Error("ipc");
      }),
      getSystemInfo: vi.fn(() => new Promise(() => {})),
    };
    render(<Host context={failing} />);
    open();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("status")).toHaveTextContent("正在读取…");
    expect(screen.getByRole("button", { name: "预览" })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByText("应用版本：未知")).toBeInTheDocument();
    expect(screen.getByText("系统：未知")).toBeInTheDocument();
    expect(screen.getByText("对话语言：未知")).toBeInTheDocument();
  });

  it("keeps an edited unsaved preview on close and hide until an explicit return to the description (R128)", async () => {
    const { rerender } = render(<Host context={failing} />);
    const opener = open();
    await screen.findByText("应用版本：0.8.10");
    fireEvent.change(describeBox(), { target: { value: "原来的问题描述" } });
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    const edited = `${previewText()}\n仅在预览补充的复现步骤`;
    fireEvent.change(screen.getByRole("textbox", { name: /预览/ }), {
      target: { value: edited },
    });
    fireEvent.click(screen.getByRole("button", { name: "关闭反馈" }));
    expect(opener).toHaveFocus();
    open();
    expect(screen.getByRole("textbox", { name: /预览/ })).toHaveValue(edited);
    expect(screen.getByRole("textbox", { name: /预览/ })).toHaveFocus();
    rerender(<Host context={failing} shown={false} />);
    expect(screen.queryByRole("textbox", { name: /预览/ })).toBeNull();
    rerender(<Host context={failing} shown />);
    open();
    expect(screen.getByRole("textbox", { name: /预览/ })).toHaveValue(edited);
    expect(save()).not.toHaveBeenCalled();
    // Only this explicit action discards the preview edits, as its hint says.
    expect(
      screen.getByText("返回修改会放弃对预览的修改。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回修改" }));
    expect(describeBox()).toHaveValue("原来的问题描述");
    await screen.findByText("应用版本：0.8.10");
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(previewText()).not.toContain("仅在预览补充的复现步骤");
  });

  it("locks the submitted preview while saving and keeps edits made after a successful save unsaved (R128)", async () => {
    let finish!: (r: { saved: boolean }) => void;
    save().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<Host context={failing} />);
    open();
    await screen.findByText("应用版本：0.8.10");
    fireEvent.change(describeBox(), { target: { value: "保存过程" } });
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    const submitted = previewText();
    fireEvent.click(screen.getByRole("button", { name: "保存…" }));
    const field = screen.getByRole("textbox", { name: /预览/ });
    expect(field).toHaveAttribute("readonly");
    // A queued change must not replace what this save claims to have persisted.
    fireEvent.change(field, { target: { value: "保存中不能改动" } });
    expect(field).toHaveValue(submitted);
    await act(async () => finish({ saved: true }));
    expect(screen.getByText("已保存。")).toBeInTheDocument();
    expect(field).not.toHaveAttribute("readonly");
    const updated = `${submitted}\n保存后新增的步骤`;
    fireEvent.change(field, { target: { value: updated } });
    expect(screen.queryByText("已保存。")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭反馈" }));
    open();
    expect(screen.getByRole("textbox", { name: /预览/ })).toHaveValue(updated);
    fireEvent.click(screen.getByRole("button", { name: "保存…" }));
    await screen.findByText("已保存。");
    expect(save().mock.calls[0]?.[1]).toBe(submitted);
    expect(save().mock.calls[1]?.[1]).toBe(updated);
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    open();
    expect(describeBox()).toHaveValue("");
  });

  it("keeps Esc from closing it while a save is in progress", async () => {
    let finish!: (r: { saved: boolean }) => void;
    save().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<Host context={failing} />);
    open();
    await screen.findByText("应用版本：0.8.10");
    fireEvent.change(describeBox(), { target: { value: "保存中按 Esc" } });
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    fireEvent.click(screen.getByRole("button", { name: "保存…" }));
    expect(screen.getByRole("status")).toHaveTextContent("正在保存…");
    expect(screen.getByRole("button", { name: "关闭反馈" })).toBeDisabled();
    const dialog = screen.getByRole("dialog", { name: "反馈" });
    const during = new Event("cancel", { cancelable: true });
    fireEvent(dialog, during);
    expect(during.defaultPrevented).toBe(true);
    await act(async () => finish({ saved: true }));
    expect(screen.getByText("已保存。")).toBeInTheDocument();
    const after = new Event("cancel", { cancelable: true });
    fireEvent(dialog, after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("is not there without a way to save", () => {
    mock.bridge = { getAppVersion: vi.fn(async () => "0.8.10") };
    render(<Host context={failing} />);
    open();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
