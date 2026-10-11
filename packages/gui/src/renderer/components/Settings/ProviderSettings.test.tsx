import type { ProviderConfig } from "@herta/providers";
import { fireEvent, screen, waitFor } from "@testing-library/react";
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
  const bridge = {
    ...base,
    getProviderSettings,
    saveProvider,
    deleteProvider,
    setProviderBindings,
    discoverProviderModels,
    validateProviderModel,
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
  };
}
async function createDraft() {
  fireEvent.click(await screen.findByRole("button", { name: "新增 Provider" }));
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
    await screen.findByText(/尚无连接/);
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
    expect(await screen.findByText(/配置已安全保存/)).toBeInTheDocument();
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
    await screen.findByText(/配置已安全保存/);
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
    expect(screen.getByText(/不会激活未验证模型/)).toBeInTheDocument();
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
    expect(screen.getByText(/文本测试成功不代表工具可用/)).toBeInTheDocument();
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
    expect(await screen.findByRole("alert")).toHaveTextContent("仍可手填模型");
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
    fireEvent.click(screen.getByRole("button", { name: "清除会话覆盖" }));
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
    expect(await screen.findByText("Provider 已删除。")).toBeInTheDocument();
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
  fireEvent.click(await screen.findByRole("button", { name: "新增 Provider" }));
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
  fireEvent.click(await screen.findByRole("button", { name: "新增 Provider" }));
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
  fireEvent.click(await screen.findByRole("button", { name: "新增 Provider" }));
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
