import type { ProviderConfig } from "@herta/providers";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProviderSettingsView } from "../../../shared/provider-settings-ipc.js";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { ProviderSettings } from "./ProviderSettings.js";
import { SettingsModal } from "./SettingsModal.js";

const empty: ProviderSettingsView = {
  settings: {
    schemaVersion: 1,
    providers: [],
    defaultBindings: null,
    sessionBindings: {},
  },
  credentialStatuses: {},
  runtimeActive: false,
};
const provider: ProviderConfig = {
  id: "p1",
  name: "自建网关",
  protocol: "openai-chat-completions",
  baseURL: "https://gateway.example/prefix/v1",
  authentication: "api-key",
  credentialRef: "secure:p1",
  allowRemoteHTTP: false,
  models: [
    {
      id: "manual-model",
      source: "manual",
      capabilities: {
        streaming: "unknown",
        tools: "unknown",
        images: "unknown",
        reasoning: "unknown",
      },
      validation: {
        state: "unverified",
        protocol: "openai-chat-completions",
        providerRevision: 1,
      },
    },
  ],
  defaults: { model: "manual-model", timeoutMs: 60000 },
  revision: 1,
};
const populated: ProviderSettingsView = {
  ...empty,
  settings: { ...empty.settings, providers: [provider] },
  credentialStatuses: { p1: { set: true, encrypted: true } },
};
function setup(view = empty, modal = false) {
  const base = createMockHertaBridge().bridge;
  const getProviderSettings = vi.fn().mockResolvedValue(view);
  const saveProvider = vi.fn().mockResolvedValue(view);
  const deleteProvider = vi.fn().mockResolvedValue(empty);
  const setProviderBindings = vi.fn().mockResolvedValue(view);
  const discoverProviderModels = vi
    .fn()
    .mockResolvedValue({ view, models: [], cached: false });
  const validateProviderModel = vi
    .fn()
    .mockResolvedValue({ view, validation: provider.models[0]?.validation });
  const resetImageChecks = vi
    .fn()
    .mockResolvedValue({ view, preserved: "provider-image-checks.json.damaged-test" });
  const bridge = {
    ...base,
    getProviderSettings,
    saveProvider,
    deleteProvider,
    setProviderBindings,
    discoverProviderModels,
    validateProviderModel,
    resetImageChecks,
  };
  const close = vi.fn();
  const onControl = vi.fn();
  renderWithLocale(
    <HertaBridgeProvider bridge={bridge}>
      {modal ? (
        <SettingsModal open onClose={close} sessionId="session-1" />
      ) : (
        <ProviderSettings sessionId="session-1" onControl={onControl} />
      )}
    </HertaBridgeProvider>,
  );
  return {
    bridge,
    close,
    onControl,
    getProviderSettings,
    saveProvider,
    deleteProvider,
    setProviderBindings,
    discoverProviderModels,
    validateProviderModel,
    resetImageChecks,
  };
}
async function createDraft() {
  fireEvent.click(await screen.findByRole("button", { name: "新增连接" }));
  fireEvent.change(screen.getByLabelText("自定义名称"), {
    target: { value: "我的连接" },
  });
  fireEvent.change(screen.getByLabelText("模型 ID"), {
    target: { value: "any-model-v2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
}
describe("R2 Provider 配置交互（确定性测试，不是 API 验证）", () => {
  it.each(["text", "tools"] as const)("saves and verifies only the selected model for %s use", async (kind) => {
    const mock = setup(populated);
    mock.validateProviderModel.mockImplementation(async (input) => {
      const model = { ...provider.models[0]!, capabilities: { ...provider.models[0]!.capabilities, tools: input.kind === "tools" ? "supported" : "unknown" }, validation: { ...provider.models[0]!.validation, state: input.kind === "tools" ? "tools-available" : "text-available" } };
      return { view: { ...populated, settings: { ...populated.settings, providers: [{ ...provider, models: [model] }] } }, validation: model.validation };
    });
    fireEvent.click(await screen.findByRole("button", { name: "编辑 自建网关" }));
    fireEvent.change(screen.getByLabelText("验证用途"), { target: { value: kind } });
    fireEvent.click(screen.getByRole("button", { name: "保存并验证" }));
    await screen.findByText(kind === "text" ? /已保存并通过聊天验证/ : /已保存并通过文本与工具验证/);
    expect(mock.validateProviderModel.mock.calls.map(([input]) => input.kind)).toEqual(kind === "text" ? ["text"] : ["text", "tools"]);
    expect(mock.validateProviderModel).toHaveBeenCalledWith({ providerId: "p1", modelId: "manual-model", expectedRevision: 1, kind: "text" });
    expect(mock.setProviderBindings).not.toHaveBeenCalled();
  });
  it("save-and-verify sends no probe when the save kept the model's current results (R83)", async () => {
    const mock = setup(populated);
    // Main kept the model's results across a save that did not change the connection.
    const verified = {
      ...provider.models[0]!,
      capabilities: { streaming: "supported", tools: "supported", images: "supported", reasoning: "unknown" } as const,
      validation: { state: "tools-available", protocol: provider.protocol, providerRevision: 2 } as const,
    };
    mock.saveProvider.mockResolvedValue({ ...populated, settings: { ...populated.settings, providers: [{ ...provider, revision: 2, models: [verified] }] } });
    fireEvent.click(await screen.findByRole("button", { name: "编辑 自建网关" }));
    fireEvent.change(screen.getByLabelText("验证用途"), { target: { value: "tools" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并验证" }));
    await screen.findByText(/已保存并通过文本与工具验证/);
    expect(mock.validateProviderModel).not.toHaveBeenCalled();
    // The saved-connection summary says the image result too, not only inside the editor.
    expect(screen.getByText(/manual-model：工具可用 · 识图通过/)).toBeInTheDocument();
  });
  it("测试识图 probes images for the chosen model, says the result and marks the model row (R77)", async () => {
    const mock = setup(populated);
    mock.validateProviderModel.mockImplementation(async (input) => {
      const model = { ...provider.models[0]!, capabilities: { ...provider.models[0]!.capabilities, images: "supported" as const } };
      return { view: { ...populated, settings: { ...populated.settings, providers: [{ ...provider, models: [model] }] } }, validation: model.validation, images: { supported: input.kind === "images" } };
    });
    fireEvent.click(await screen.findByRole("button", { name: "编辑 自建网关" }));
    fireEvent.click(screen.getByRole("button", { name: "测试识图" }));
    expect(await screen.findByText("识图检测通过：附加的图片会发给该模型。")).toBeInTheDocument();
    expect(mock.validateProviderModel).toHaveBeenCalledWith({ providerId: "p1", modelId: "manual-model", expectedRevision: 1, kind: "images" });
    expect(screen.getByText(/manual-model · 未验证 · 识图通过/)).toBeInTheDocument();
    mock.validateProviderModel.mockResolvedValueOnce({ view: populated, validation: provider.models[0]!.validation, images: { supported: false, diagnostic: "模型没有正确说出测试图片的颜色，图片可能未被读取。" } });
    fireEvent.click(screen.getByRole("button", { name: "测试识图" }));
    expect(await screen.findByText("识图检测未通过：模型没有正确说出测试图片的颜色，图片可能未被读取。")).toBeInTheDocument();
  });
  it("keeps a failed save-and-verify editable and does not activate or continue probing", async () => {
    const mock = setup(populated);
    fireEvent.click(await screen.findByRole("button", { name: "编辑 自建网关" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并验证" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("原有绑定未更改");
    expect(screen.getByLabelText("自定义名称")).toHaveValue(provider.name);
    expect(mock.validateProviderModel).toHaveBeenCalledTimes(1);
    expect(mock.setProviderBindings).not.toHaveBeenCalled();
  });
  it("failed reads leave existing storage untouched and can be retried", async () => {
    const base = createMockHertaBridge().bridge;
    const getProviderSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error("raw diagnostic"))
      .mockResolvedValue(empty);
    const saveProvider = vi.fn();
    renderWithLocale(
      <HertaBridgeProvider
        bridge={{ ...base, getProviderSettings, saveProvider }}
      >
        <ProviderSettings onControl={vi.fn()} />
      </HertaBridgeProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("读取失败");
    expect(saveProvider).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重试读取" }));
    await screen.findByText(/还没有连接/);
    expect(getProviderSettings).toHaveBeenCalledTimes(2);
  });
  it("supports all three explicit protocols, hand-entered model and safe write-only key", async () => {
    const mock = setup();
    await createDraft();
    const protocol = screen.getByLabelText("API 协议");
    expect(protocol.querySelectorAll("option")).toHaveLength(3);
    fireEvent.change(protocol, { target: { value: "anthropic-messages" } });
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://proxy.example/api/v1" },
    });
    fireEvent.change(screen.getByLabelText("凭据操作"), {
      target: { value: "replace" },
    });
    const key = screen.getByLabelText("API Key");
    expect(key).toHaveAttribute("type", "password");
    fireEvent.change(key, { target: { value: "unit-only-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    await waitFor(() => expect(mock.saveProvider).toHaveBeenCalled());
    expect(mock.saveProvider.mock.calls[0]?.[0]).toMatchObject({
      name: "我的连接",
      protocol: "anthropic-messages",
      baseURL: "https://proxy.example/api/v1",
      models: [{ id: "any-model-v2" }],
      defaults: { model: "any-model-v2" },
      credential: { action: "replace", value: "unit-only-secret" },
    });
    expect(await screen.findByText(/连接已保存。下一步/)).toBeInTheDocument();
    expect(screen.queryByLabelText("API Key")).toBeNull();
    expect(mock.validateProviderModel).not.toHaveBeenCalled();
    expect(mock.discoverProviderModels).not.toHaveBeenCalled();
    expect(mock.setProviderBindings).not.toHaveBeenCalled();
  });
  it("shows saved credential state without plaintext and keeps it on rename", async () => {
    const mock = setup(populated);
    fireEvent.click(
      await screen.findByRole("button", { name: "编辑 自建网关" }),
    );
    expect(screen.getByText(/凭据已加密保存/)).toBeInTheDocument();
    expect(screen.queryByLabelText("API Key")).toBeNull();
    fireEvent.change(screen.getByLabelText("自定义名称"), {
      target: { value: "重命名" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    await waitFor(() => expect(mock.saveProvider).toHaveBeenCalled());
    expect(mock.saveProvider.mock.calls[0]?.[0]).toMatchObject({
      id: "p1",
      expectedRevision: 1,
      credential: { action: "keep" },
    });
  });
  it("leaves failed input intact, sanitizes diagnostics and allows retry", async () => {
    const mock = setup();
    await createDraft();
    mock.saveProvider.mockRejectedValueOnce(
      new Error("secret raw unit-only-secret"),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("原配置已保留");
    expect(screen.getByLabelText("自定义名称")).toHaveValue("我的连接");
    expect(document.body.textContent).not.toContain("unit-only-secret");
    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    await screen.findByText(/连接已保存。下一步/);
    expect(mock.saveProvider).toHaveBeenCalledTimes(2);
  });
  it("does not silently discard an unadded model on save", async () => {
    const mock = setup();
    await createDraft();
    fireEvent.change(screen.getByLabelText("模型 ID"), {
      target: { value: "pending-model" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请先添加模型");
    expect(mock.saveProvider).not.toHaveBeenCalled();
    expect(screen.getByLabelText("模型 ID")).toHaveValue("pending-model");
  });
  it("network probes require a saved configuration without pending edits", async () => {
    setup();
    await createDraft();
    for (const name of ["获取模型", "测试文本", "测试工具"])
      expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(screen.getByText(/只保存连接不发送请求/)).toBeInTheDocument();
  });
  it("tests the saved target revision and reflects text without claiming tools", async () => {
    const mock = setup(populated);
    const validation = {
      ...provider.models[0]?.validation,
      state: "text-available" as const,
    };
    const verified = {
      ...populated,
      settings: {
        ...populated.settings,
        providers: [
          { ...provider, models: [{ ...provider.models[0], validation }] },
        ],
      },
    };
    mock.validateProviderModel.mockResolvedValueOnce({
      view: verified,
      validation,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "编辑 自建网关" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "测试文本" }));
    await waitFor(() =>
      expect(mock.validateProviderModel).toHaveBeenCalledWith({
        providerId: "p1",
        modelId: "manual-model",
        expectedRevision: 1,
        kind: "text",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("文本可用");
    expect(screen.getByText(/文本可用不代表工具可用/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://other.example/v1" },
    });
    expect(screen.getByRole("button", { name: "测试工具" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "获取模型" })).toBeDisabled();
  });
  it("does not show raw diagnostics when model discovery fails", async () => {
    const mock = setup(populated);
    mock.discoverProviderModels.mockRejectedValueOnce(
      new Error("secret-fixture-only"),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "编辑 自建网关" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("也可以手动填写模型");
    expect(document.body.textContent).not.toContain("secret-fixture-only");
    expect(screen.getByLabelText("Base URL")).toHaveValue(provider.baseURL);
  });
  it("persists session role bindings and supports inheritance", async () => {
    const mock = setup(populated);
    await screen.findByRole("button", { name: "编辑 自建网关" });
    fireEvent.change(screen.getByLabelText("绑定范围"), {
      target: { value: "session" },
    });
    fireEvent.change(screen.getByLabelText("黑塔对话模型"), {
      target: { value: JSON.stringify(["p1", "manual-model"]) },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存模型绑定" }));
    await waitFor(() =>
      expect(mock.setProviderBindings).toHaveBeenCalledWith({
        sessionId: "session-1",
        bindings: {
          persona: { providerId: "p1", modelId: "manual-model" },
          executor: { providerId: "p1", modelId: "manual-model" },
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "清除任务覆盖" }));
    await waitFor(() =>
      expect(mock.setProviderBindings).toHaveBeenLastCalledWith({
        sessionId: "session-1",
        bindings: null,
      }),
    );
  });
  it("delete requires explicit confirmation and removes matching entry", async () => {
    const mock = setup(populated);
    fireEvent.click(
      await screen.findByRole("button", { name: "删除 自建网关" }),
    );
    expect(mock.deleteProvider).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消删除" }));
    expect(mock.deleteProvider).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除 自建网关" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(mock.deleteProvider).toHaveBeenCalledWith("p1"));
    expect(await screen.findByText("连接已删除。")).toBeInTheDocument();
  });
  it("dirty editor intercepts navigation, Escape and can discard", async () => {
    const mock = setup(empty, true);
    await createDraft();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(mock.close).not.toHaveBeenCalled();
    expect(screen.getByText(/连接有未保存修改/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "关于" }));
    expect(screen.getByLabelText("自定义名称")).toHaveValue("我的连接");
    fireEvent.click(screen.getByRole("button", { name: "丢弃并离开" }));
    expect(screen.getByText(/个人二次创作桌面编程助手/)).toBeInTheDocument();
    expect(mock.saveProvider).not.toHaveBeenCalled();
  });
});

const firstModel = provider.models[0] as ProviderConfig["models"][number];

describe("R132 stateful connection entry", () => {
  function readyView(): ProviderSettingsView {
    const model = {
      ...firstModel,
      capabilities: { ...firstModel.capabilities, tools: "supported" as const },
      validation: {
        ...firstModel.validation,
        state: "tools-available" as const,
      },
    };
    return {
      ...populated,
      settings: {
        ...populated.settings,
        providers: [
          { ...provider, models: [model, { ...model, id: "executor-model" }] },
        ],
        defaultBindings: {
          persona: { providerId: provider.id, modelId: "manual-model" },
          executor: { providerId: provider.id, modelId: "executor-model" },
        },
      },
    };
  }
  it("shows the saved distinct roles compactly and only opens the guided controls on request", async () => {
    const api = setup(readyView());
    const summary = await screen.findByRole("region", { name: "工作台模型配置" });
    expect(summary).toHaveTextContent("黑塔：manual-model · 自建网关");
    expect(summary).toHaveTextContent("执行：executor-model · 自建网关");
    expect(summary).toHaveTextContent("当前任务沿用全局默认");
    expect(within(summary).getByText("工作台模型")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("用于对话和编程的模型"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新增连接" })).toBeVisible();
    expect(screen.getByRole("button", { name: "编辑 自建网关" })).toBeVisible();
    fireEvent.click(within(summary).getByRole("button", { name: "调整模型" }));
    expect(screen.getByText("独立聊天在消息框选择模型。")).toBeInTheDocument();
    expect(screen.getByLabelText("用于对话和编程的模型")).toHaveValue("");
    expect(
      screen.getByText(/“验证模型”会发送小型文本与工具测试请求/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设为全局默认" })).toBeDisabled();
    fireEvent.click(within(summary).getByRole("button", { name: "收起调整" }));
    expect(
      screen.queryByLabelText("用于对话和编程的模型"),
    ).not.toBeInTheDocument();
    expect(api.validateProviderModel).not.toHaveBeenCalled();
    expect(api.setProviderBindings).not.toHaveBeenCalled();
  });
  it("reports the task override, independent of the unsaved advanced scope or model choice", async () => {
    const view = readyView();
    const taskModel = { providerId: provider.id, modelId: "executor-model" };
    const api = setup({
      ...view,
      settings: {
        ...view.settings,
        sessionBindings: {
          "session-1": { persona: taskModel, executor: taskModel },
        },
      },
    });
    const summary = await screen.findByRole("region", { name: "工作台模型配置" });
    expect(summary).toHaveTextContent("当前任务独立配置");
    expect(summary).toHaveTextContent("黑塔：executor-model");
    expect(summary).not.toHaveTextContent("manual-model");
    fireEvent.click(screen.getByText("高级设置 · 对话与编程模型"));
    fireEvent.change(screen.getByLabelText("黑塔对话模型"), {
      target: { value: JSON.stringify([provider.id, "manual-model"]) },
    });
    expect(summary).toHaveTextContent("黑塔：executor-model");
    expect(api.setProviderBindings).not.toHaveBeenCalled();
  });
  it.each([
    "revision",
    "protocol",
    "tools",
    "credential",
    "missing-model",
    "missing-provider",
  ] as const)("keeps the guided repair controls visible for an unusable binding: %s", async (problem) => {
    const view = readyView();
    const original = view.settings.providers[0]!;
    const p: ProviderConfig = {
      ...original,
      revision:
        problem === "revision" ? original.revision + 1 : original.revision,
      models:
        problem === "missing-model"
          ? original.models.slice(0, 1)
          : original.models.map((m, index) =>
              index !== 1
                ? m
                : {
                    ...m,
                    validation:
                      problem === "protocol"
                        ? { ...m.validation, protocol: "anthropic-messages" }
                        : m.validation,
                    capabilities:
                      problem === "tools"
                        ? { ...m.capabilities, tools: "unknown" }
                        : m.capabilities,
                  },
            ),
    };
    let current: ProviderSettingsView = {
      ...view,
      settings: { ...view.settings, providers: [p] },
    };
    if (problem === "credential")
      current = {
        ...current,
        credentialStatuses: { [p.id]: { set: false, encrypted: false } },
      };
    if (problem === "missing-provider")
      current = {
        ...current,
        settings: { ...current.settings, providers: [] },
      };
    const api = setup(current);
    const summary = await screen.findByRole("region", { name: "工作台模型配置" });
    expect(within(summary).getByText("工作台模型需要处理")).toBeInTheDocument();
    expect(screen.getByLabelText("用于对话和编程的模型")).toBeVisible();
    expect(
      within(summary).queryByRole("button", { name: "调整模型" }),
    ).not.toBeInTheDocument();
    expect(summary).toHaveTextContent(
      problem === "credential"
        ? "缺少 API Key"
        : problem === "missing-model"
          ? "模型已不在连接中"
          : problem === "missing-provider"
            ? "连接不存在"
            : /验证/,
    );
    expect(api.validateProviderModel).not.toHaveBeenCalled();
    expect(api.setProviderBindings).not.toHaveBeenCalled();
  });
  it("does not require a key for an explicitly unauthenticated connection", async () => {
    const view = readyView();
    setup({
      ...view,
      credentialStatuses: {},
      settings: {
        ...view.settings,
        providers: view.settings.providers.map((p) => ({
          ...p,
          authentication: "none",
          credentialRef: null,
        })),
      },
    });
    const summary = await screen.findByRole("region", { name: "工作台模型配置" });
    expect(within(summary).getByText("工作台模型")).toBeInTheDocument();
    expect(summary).not.toHaveTextContent("缺少 API Key");
  });
  it("accepts a text-verified persona with a tool-verified executor and keeps an older-check reminder", async () => {
    const view = readyView();
    setup({
      ...view,
      settings: {
        ...view.settings,
        providers: view.settings.providers.map((p) => ({
          ...p,
          models: p.models.map((m, index) =>
            index !== 0
              ? m
              : {
                  ...m,
                  capabilities: { ...m.capabilities, tools: "unknown" },
                  validation: {
                    ...m.validation,
                    state: "text-available",
                    checkedAt: new Date(
                      Date.now() - 31 * 86400000,
                    ).toISOString(),
                  },
                },
          ),
        })),
      },
    });
    const summary = await screen.findByRole("region", { name: "工作台模型配置" });
    expect(within(summary).getByText("工作台模型")).toBeInTheDocument();
    expect(summary).toHaveTextContent("文本可用（已超过30天，建议重新验证）");
    expect(
      screen.queryByLabelText("用于对话和编程的模型"),
    ).not.toBeInTheDocument();
  });
  it("keeps first-use guidance when verified models have not been applied", async () => {
    const view = readyView();
    const api = setup({
      ...view,
      settings: { ...view.settings, defaultBindings: null },
    });
    expect(
      await screen.findByRole("region", { name: "首次配置引导" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "工作台模型配置" }),
    ).not.toBeInTheDocument();
    expect(api.setProviderBindings).not.toHaveBeenCalled();
  });
  it("opens the explicit apply flow after save-and-verify without reprobing or applying a binding", async () => {
    const api = setup(readyView());
    fireEvent.click(
      await screen.findByRole("button", { name: "编辑 自建网关" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存并验证" }));
    await screen.findByText(/已保存并通过文本与工具验证/);
    expect(screen.getByLabelText("用于对话和编程的模型")).toHaveValue(
      JSON.stringify([provider.id, "manual-model"]),
    );
    expect(screen.getByRole("button", { name: "用于当前任务" })).toBeEnabled();
    expect(api.validateProviderModel).not.toHaveBeenCalled();
    expect(api.setProviderBindings).not.toHaveBeenCalled();
  });
});

describe("R6 first-use setup (deterministic UI, not service verification)", () => {
  it("requires explicit text and tool validation, then a separate binding action", async () => {
    const mock = setup(populated);
    await screen.findByLabelText("用于对话和编程的模型");
    expect(mock.validateProviderModel).not.toHaveBeenCalled();
    expect(mock.setProviderBindings).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("用于对话和编程的模型"), {
      target: { value: JSON.stringify(["p1", "manual-model"]) },
    });
    expect(screen.getByRole("button", { name: "设为全局默认" })).toBeDisabled();
    const textValidation = {
      ...firstModel.validation,
      state: "text-available" as const,
    };
    const toolValidation = {
      ...textValidation,
      state: "tools-available" as const,
    };
    const verified = {
      ...populated,
      settings: {
        ...populated.settings,
        providers: [
          {
            ...provider,
            models: [
              {
                ...firstModel,
                capabilities: {
                  ...firstModel.capabilities,
                  tools: "supported" as const,
                },
                validation: toolValidation,
              },
            ],
          },
        ],
      },
    };
    mock.validateProviderModel
      .mockResolvedValueOnce({ view: populated, validation: textValidation })
      .mockResolvedValueOnce({ view: verified, validation: toolValidation });
    fireEvent.click(
      screen.getByRole("button", { name: "验证模型（文本 + 工具）" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "设为全局默认" }),
      ).toBeEnabled(),
    );
    expect(
      mock.validateProviderModel.mock.calls.map(([input]) => input.kind),
    ).toEqual(["text", "tools"]);
    expect(
      mock.validateProviderModel.mock.calls.every(
        ([input]) => input.expectedRevision === 1,
      ),
    ).toBe(true);
    expect(mock.setProviderBindings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "用于当前任务" }));
    await waitFor(() =>
      expect(mock.setProviderBindings).toHaveBeenCalledWith({
        sessionId: "session-1",
        bindings: {
          persona: { providerId: "p1", modelId: "manual-model" },
          executor: { providerId: "p1", modelId: "manual-model" },
        },
      }),
    );
  });
  it("stops after failed text validation and shows only the safe result diagnostic", async () => {
    const mock = setup(populated);
    await screen.findByLabelText("用于对话和编程的模型");
    fireEvent.change(screen.getByLabelText("用于对话和编程的模型"), {
      target: { value: JSON.stringify(["p1", "manual-model"]) },
    });
    mock.validateProviderModel.mockResolvedValueOnce({
      view: populated,
      validation: {
        ...firstModel.validation,
        state: "failed",
        diagnostic: "鉴权失败，请在本机检查凭据。",
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "验证模型（文本 + 工具）" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("鉴权失败");
    expect(mock.validateProviderModel).toHaveBeenCalledTimes(1);
    expect(mock.setProviderBindings).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "设为全局默认" })).toBeDisabled();
  });
  it("invalidates stale revision and preserves existing session override warning", async () => {
    const model = {
      ...firstModel,
      capabilities: {
        ...firstModel.capabilities,
        tools: "supported" as const,
      },
      validation: {
        ...firstModel.validation,
        state: "tools-available" as const,
      },
    };
    setup({
      ...populated,
      settings: {
        ...populated.settings,
        providers: [{ ...provider, revision: 2, models: [model] }],
        sessionBindings: {
          "session-1": {
            persona: { providerId: "p1", modelId: "manual-model" },
            executor: { providerId: "p1", modelId: "manual-model" },
          },
        },
      },
    });
    await screen.findByLabelText("用于对话和编程的模型");
    fireEvent.change(screen.getByLabelText("用于对话和编程的模型"), {
      target: { value: JSON.stringify(["p1", "manual-model"]) },
    });
    expect(screen.getByRole("button", { name: "设为全局默认" })).toBeDisabled();
    expect(screen.getByText(/当前任务已有独立配置/)).toBeInTheDocument();
    expect(screen.getByText(/连接已修改，请重新验证/)).toBeInTheDocument();
  });
});

it("R6 advanced models can bind a distinct executor without silently applying", async () => {
  const second = { ...provider, id: "p2", name: "执行连接" };
  const mock = setup({
    ...populated,
    settings: { ...populated.settings, providers: [provider, second] },
  });
  await screen.findByLabelText("黑塔对话模型");
  fireEvent.change(screen.getByLabelText("黑塔对话模型"), {
    target: { value: JSON.stringify(["p1", "manual-model"]) },
  });
  fireEvent.click(screen.getByLabelText("分别选择编程执行模型"));
  fireEvent.change(screen.getByLabelText("编程执行模型"), {
    target: { value: JSON.stringify(["p2", "manual-model"]) },
  });
  expect(mock.setProviderBindings).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "保存模型绑定" }));
  await waitFor(() =>
    expect(mock.setProviderBindings).toHaveBeenCalledWith({
      bindings: {
        persona: { providerId: "p1", modelId: "manual-model" },
        executor: { providerId: "p2", modelId: "manual-model" },
      },
    }),
  );
});

it("fills a DeepSeek preset without requests and saves with only key plus model selection", async () => {
  const api = setup();
  fireEvent.click(await screen.findByRole("button", { name: "新增连接" }));
  fireEvent.change(screen.getByLabelText("服务商预设", { exact: false }), {
    target: { value: "deepseek" },
  });
  expect(screen.getByLabelText("API 协议")).toHaveValue(
    "openai-chat-completions",
  );
  expect(screen.getByLabelText("Base URL")).toHaveValue(
    "https://api.deepseek.com",
  );
  fireEvent.change(screen.getByLabelText("API Key", { exact: true }), {
    target: { value: "test-only-value" },
  });
  fireEvent.change(screen.getByLabelText("默认模型"), {
    target: { value: "deepseek-v4-pro" },
  });
  expect(api.discoverProviderModels).not.toHaveBeenCalled();
  expect(api.validateProviderModel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
  await waitFor(() =>
    expect(api.saveProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "DeepSeek",
        protocol: "openai-chat-completions",
        baseURL: "https://api.deepseek.com",
        credential: { action: "replace", value: "test-only-value" },
        defaults: { model: "deepseek-v4-pro", timeoutMs: 120000 },
      }),
    ),
  );
});
it("clears unsaved credentials on a service change and explains Antigravity without inventing an endpoint", async () => {
  const api = setup();
  fireEvent.click(await screen.findByRole("button", { name: "新增连接" }));
  const preset = screen.getByLabelText("服务商预设", { exact: false });
  fireEvent.change(preset, { target: { value: "deepseek" } });
  fireEvent.change(screen.getByLabelText("API Key", { exact: true }), {
    target: { value: "test-only-value" },
  });
  fireEvent.change(preset, { target: { value: "anthropic" } });
  expect(screen.getByLabelText("API Key", { exact: true })).toHaveValue("");
  expect(screen.getByLabelText("Base URL")).toHaveValue(
    "https://api.anthropic.com/v1",
  );
  fireEvent.change(preset, { target: { value: "antigravity" } });
  expect(screen.getByText(/本版不接入它的账号登录/)).toBeInTheDocument();
  expect(api.saveProvider).not.toHaveBeenCalled();
  expect(api.discoverProviderModels).not.toHaveBeenCalled();
});
it("saves first then explicitly discovers account models, preserving the saved connection on discovery error", async () => {
  const api = setup();
  api.saveProvider.mockResolvedValue(populated);
  api.discoverProviderModels.mockRejectedValue(
    new Error("remote-private-error"),
  );
  fireEvent.click(await screen.findByRole("button", { name: "新增连接" }));
  fireEvent.change(screen.getByLabelText("服务商预设", { exact: false }), {
    target: { value: "deepseek" },
  });
  // Return a matching persisted connection, as the real bridge does.
  const saved = {
    ...provider,
    name: "DeepSeek",
    protocol: "openai-chat-completions" as const,
    baseURL: "https://api.deepseek.com",
    defaults: { model: "deepseek-flash", timeoutMs: 120000 },
  };
  api.saveProvider.mockResolvedValue({
    ...populated,
    settings: { ...populated.settings, providers: [saved] },
  });
  fireEvent.change(screen.getByLabelText("API Key", { exact: true }), {
    target: { value: "test-only-value" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存并获取账户模型" }));
  await screen.findByText(/连接已保存，但获取模型失败/);
  expect(api.discoverProviderModels).toHaveBeenCalledWith({
    providerId: "p1",
    expectedRevision: 1,
    refresh: true,
  });
  expect(screen.queryByText("remote-private-error")).not.toBeInTheDocument();
  expect(api.deleteProvider).not.toHaveBeenCalled();
});

describe("R68 setup choice shows the model in use", () => {
  const second = { ...firstModel, id: "other-model" };
  const two: ProviderConfig = { ...provider, models: [firstModel, second] };
  const bound = (persona: string, executor: string, session?: string): ProviderSettingsView => ({
    ...populated,
    settings: {
      ...populated.settings,
      providers: [two],
      defaultBindings: { persona: { providerId: "p1", modelId: persona }, executor: { providerId: "p1", modelId: executor } },
      sessionBindings: session ? { "session-1": { persona: { providerId: "p1", modelId: session }, executor: { providerId: "p1", modelId: session } } } : {},
    },
  });
  it("preselects the global model when chat and coding share it", async () => {
    setup(bound("manual-model", "manual-model"));
    await waitFor(() => expect(screen.getByLabelText("用于对话和编程的模型")).toHaveValue(JSON.stringify(["p1", "manual-model"])));
  });
  it("prefers this task's own binding", async () => {
    setup(bound("manual-model", "manual-model", "other-model"));
    await waitFor(() => expect(screen.getByLabelText("用于对话和编程的模型")).toHaveValue(JSON.stringify(["p1", "other-model"])));
  });
  it("leaves the choice empty when chat and coding use different models", async () => {
    setup(bound("manual-model", "other-model"));
    await screen.findByLabelText("用于对话和编程的模型");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByLabelText("用于对话和编程的模型")).toHaveValue("");
  });
});

describe("F06 validation results (R104, deterministic UI, not service verification)", () => {
  const withModel = (model: ProviderConfig["models"][number], revision = 1): ProviderSettingsView => ({
    ...populated,
    settings: { ...populated.settings, providers: [{ ...provider, revision, models: [model] }] },
  });
  const passed = (checkedAt: string, providerRevision = 1) => ({
    ...provider.models[0]!,
    validation: { ...provider.models[0]!.validation, state: "text-available" as const, providerRevision, checkedAt },
  });

  it("says a probe that saved nothing kept the earlier result", async () => {
    const view = withModel(passed(new Date().toISOString()));
    const mock = setup(view);
    const model = view.settings.providers[0]!.models[0]!;
    mock.validateProviderModel.mockResolvedValueOnce({
      view,
      validation: model.validation,
      kept: { reason: "transient", diagnostic: "模型请求超时，已保存的结果保留。请检查连接后再试。" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "编辑 自建网关" }));
    fireEvent.click(screen.getByRole("button", { name: "测试工具" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "验证未完成：模型请求超时，已保存的结果保留。请检查连接后再试。已有验证结果保留，可稍后重试。",
    );
    expect(screen.getByText(/manual-model · 文本可用/, { selector: "span" })).toBeInTheDocument();
    mock.validateProviderModel.mockResolvedValueOnce({ view, validation: model.validation, superseded: true });
    fireEvent.click(screen.getByRole("button", { name: "测试文本" }));
    expect(await screen.findByText("已有更新的验证在进行，本次结果未采用。")).toBeInTheDocument();
  });

  it("does not show a result for an earlier connection as current", async () => {
    setup(withModel(passed(new Date().toISOString(), 1), 2));
    expect(await screen.findByText(/manual-model：需重新验证（连接已修改）/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑 自建网关" }));
    expect(screen.getByText(/manual-model · 需重新验证（连接已修改）/, { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByText(/manual-model · 文本可用/, { selector: "span" })).not.toBeInTheDocument();
  });

  it("reminds about a pass older than 30 days without probing, and dates every result", async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const mock = setup(withModel(passed(old)));
    fireEvent.click(await screen.findByRole("button", { name: "编辑 自建网关" }));
    const row = screen.getByText(/manual-model · 文本可用（已超过30天，建议重新验证）/, { selector: "span" });
    expect(row).toHaveAttribute("title", expect.stringContaining("上次验证："));
    expect(mock.validateProviderModel).not.toHaveBeenCalled();
  });

  it("a fresh pass carries no reminder", async () => {
    setup(withModel(passed(new Date().toISOString())));
    fireEvent.click(await screen.findByRole("button", { name: "编辑 自建网关" }));
    expect(screen.getByText(/manual-model · 文本可用/, { selector: "span" })).not.toHaveTextContent("建议重新验证");
  });

  it("first-use setup stops on a probe that saved nothing and says why", async () => {
    const mock = setup(populated);
    await screen.findByLabelText("用于对话和编程的模型");
    fireEvent.change(screen.getByLabelText("用于对话和编程的模型"), {
      target: { value: JSON.stringify(["p1", "manual-model"]) },
    });
    mock.validateProviderModel.mockResolvedValueOnce({
      view: populated,
      validation: provider.models[0]!.validation,
      kept: { reason: "authentication", diagnostic: "服务拒绝鉴权或访问权限。请检查该连接的 API Key 和账户授权。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "验证模型（文本 + 工具）" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("验证未完成：服务拒绝鉴权");
    expect(mock.validateProviderModel).toHaveBeenCalledTimes(1);
  });

  it("save-and-verify names the reason when the probe saved nothing", async () => {
    const mock = setup(populated);
    mock.validateProviderModel.mockResolvedValueOnce({
      view: populated,
      validation: provider.models[0]!.validation,
      kept: { reason: "transient", diagnostic: "无法连接模型服务，请检查网络与服务地址。" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "编辑 自建网关" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并验证" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "连接已保存。验证未完成：无法连接模型服务，请检查网络与服务地址。",
    );
  });
});

describe("F06 image check dates (R109, deterministic UI, not service verification)", () => {
  const imaged = (
    images: "supported" | "unsupported" | "unknown",
    imageChecks: ProviderSettingsView["imageChecks"],
    extra: Partial<ProviderSettingsView> = {},
  ): ProviderSettingsView => ({
    ...populated,
    settings: {
      ...populated.settings,
      providers: [{ ...provider, models: [{ ...provider.models[0]!, capabilities: { ...provider.models[0]!.capabilities, images } }] }],
    },
    imageChecks,
    ...extra,
  });
  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const row = () => screen.getByText(/^manual-model · /, { selector: "span" });

  it("dates an image result without a reminder while it is fresh", async () => {
    const mock = setup(imaged("supported", [{ providerId: "p1", modelId: "manual-model", checkedAt: daysAgo(1) }]));
    expect(await screen.findByText(/manual-model：未验证 · 识图通过$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑 自建网关" }));
    expect(row()).toHaveTextContent(/· 识图通过$/);
    expect(row()).toHaveAttribute("title", expect.stringContaining("识图检测："));
    expect(mock.validateProviderModel).not.toHaveBeenCalled();
  });

  it("reminds about an image pass older than 30 days without probing", async () => {
    const mock = setup(imaged("supported", [{ providerId: "p1", modelId: "manual-model", checkedAt: daysAgo(40) }]));
    expect(await screen.findByText(/识图通过（已超过30天，建议重新测试识图）/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑 自建网关" }));
    expect(row()).toHaveTextContent("识图通过（已超过30天，建议重新测试识图）");
    expect(mock.validateProviderModel).not.toHaveBeenCalled();
  });

  it("dates a failed image check without asking to retest it", async () => {
    setup(imaged("unsupported", [{ providerId: "p1", modelId: "manual-model", checkedAt: daysAgo(40) }]));
    fireEvent.click(await screen.findByRole("button", { name: "编辑 自建网关" }));
    expect(row()).toHaveTextContent(/· 识图未通过$/);
    expect(row()).toHaveAttribute("title", expect.stringContaining("识图检测："));
  });

  it("says when a connection change reset the image result", async () => {
    setup(imaged("unknown", [{ providerId: "p1", modelId: "manual-model", connectionChanged: true }]));
    expect(await screen.findByText(/manual-model：未验证 · 识图需重新测试（连接已修改）/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑 自建网关" }));
    expect(row()).toHaveTextContent("识图需重新测试（连接已修改）");
  });

  it("shows a result from before R109 as it was: no date, no reminder", async () => {
    setup(imaged("supported", undefined));
    fireEvent.click(await screen.findByRole("button", { name: "编辑 自建网关" }));
    expect(row()).toHaveTextContent(/· 识图通过$/);
    expect(row()).not.toHaveAttribute("title");
  });

  it("explains an unreadable record file and resets it only on request", async () => {
    const mock = setup(imaged("supported", [], { imageCheckIssue: "unreadable" }));
    expect(await screen.findByText(/识图检测记录文件无法读取，原文件已保留/)).toBeInTheDocument();
    expect(mock.resetImageChecks).not.toHaveBeenCalled();
    mock.resetImageChecks.mockRejectedValueOnce(new Error("locked"));
    fireEvent.click(screen.getByRole("button", { name: "另存原文件并重新记录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("重置识图检测记录失败，原文件保持不变。请重试。");
    mock.resetImageChecks.mockResolvedValueOnce({
      view: imaged("supported", []),
      preserved: "provider-image-checks.json.damaged-test",
    });
    fireEvent.click(screen.getByRole("button", { name: "另存原文件并重新记录" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "原记录文件已另存为 provider-image-checks.json.damaged-test；之后的识图检测会重新记录时间。",
    );
    expect(screen.queryByText(/识图检测记录文件无法读取/)).not.toBeInTheDocument();
    expect(mock.resetImageChecks).toHaveBeenCalledTimes(2);
  });
});

describe("F06 image review after a refused request (R110, deterministic UI, not service verification)", () => {
  const imaged = (
    images: "supported" | "unsupported" | "unknown",
    imageChecks: ProviderSettingsView["imageChecks"],
  ): ProviderSettingsView => ({
    ...populated,
    settings: {
      ...populated.settings,
      providers: [{ ...provider, models: [{ ...provider.models[0]!, capabilities: { ...provider.models[0]!.capabilities, images } }] }],
    },
    imageChecks,
  });
  const row = () => screen.getByText(/^manual-model · /, { selector: "span" });
  const review = { at: "2026-10-29T03:00:00.000Z", status: 400, surface: "workbench" as const };

  it("marks a passed result for review without changing it, and says when, where and that the cause is unknown", async () => {
    const mock = setup(imaged("supported", [{ providerId: "p1", modelId: "manual-model", checkedAt: "2026-10-28T03:00:00.000Z", review }]));
    expect(await screen.findByText(/manual-model：未验证 · 识图通过（待复核）$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑 自建网关" }));
    expect(row()).toHaveTextContent(/· 识图通过（待复核）$/);
    const title = row().getAttribute("title") ?? "";
    expect(title).toContain("识图检测：");
    expect(title).toContain(`识图待复核：${new Date(review.at).toLocaleString()}，工作台中附带图片的请求被服务拒绝（HTTP 400）。`);
    expect(title).toContain("原因未确认，识图结果未自动更改；重新测试识图后清除。");
    // Nothing re-probes on its own.
    expect(mock.validateProviderModel).not.toHaveBeenCalled();
  });

  it("marks an untested model, e.g. a documented vision model, and names the chat as the source", async () => {
    setup(imaged("unknown", [{ providerId: "p1", modelId: "manual-model", review: { ...review, status: 422, surface: "chat" } }]));
    expect(await screen.findByText(/manual-model：未验证 · 识图待复核$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑 自建网关" }));
    expect(row().getAttribute("title")).toContain("黑塔聊天中附带图片的请求被服务拒绝（HTTP 422）。");
  });

  it("keeps naming a failed result, and the review replaces the 30-day reminder", async () => {
    setup(imaged("unsupported", [{ providerId: "p1", modelId: "manual-model", review }]));
    expect(await screen.findByText(/manual-model：未验证 · 识图未通过（待复核）$/)).toBeInTheDocument();
    const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    cleanup();
    setup(imaged("supported", [{ providerId: "p1", modelId: "manual-model", checkedAt: stale, review }]));
    expect(await screen.findByText(/manual-model：未验证 · 识图通过（待复核）$/)).toBeInTheDocument();
    expect(screen.queryByText(/已超过30天/)).not.toBeInTheDocument();
  });

  it("drops the mark when 测试识图 comes back with a view that no longer has it", async () => {
    const mock = setup(imaged("supported", [{ providerId: "p1", modelId: "manual-model", review }]));
    const answered = imaged("supported", [{ providerId: "p1", modelId: "manual-model", checkedAt: "2026-10-29T04:00:00.000Z" }]);
    mock.validateProviderModel.mockResolvedValueOnce({ view: answered, validation: provider.models[0]!.validation, images: { supported: true } });
    fireEvent.click(await screen.findByRole("button", { name: "编辑 自建网关" }));
    expect(row()).toHaveTextContent(/· 识图通过（待复核）$/);
    fireEvent.click(screen.getByRole("button", { name: "测试识图" }));
    expect(await screen.findByText("识图检测通过：附加的图片会发给该模型。")).toBeInTheDocument();
    expect(row()).toHaveTextContent(/· 识图通过$/);
    expect(row().getAttribute("title")).not.toContain("识图待复核");
  });
});
