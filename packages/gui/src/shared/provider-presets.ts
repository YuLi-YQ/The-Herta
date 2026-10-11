import type { ProviderProtocol } from "@herta/providers";
/** Official endpoint templates reviewed 2026-10-08. Models are suggestions, never proof of access. */
export interface ProviderPreset {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseURL: string;
  models: readonly string[];
  note?: string;
}
export const providerPresets: readonly ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-responses",
    baseURL: "https://api.openai.com/v1",
    models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic-messages",
    baseURL: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    protocol: "openai-chat-completions",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-3.8-flash"],
    note: "使用 Google AI Studio 的 Gemini API Key。",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-chat-completions",
    baseURL: "https://api.deepseek.com",
    models: ["deepseek-flash", "deepseek-v4-pro"],
  },
  {
    id: "qwen-cn",
    name: "Qwen · 百炼北京",
    protocol: "openai-chat-completions",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus", "qwen3.5-plus"],
    note: "使用北京地域的按量 API Key。业务空间专属地址或 Coding / Token Plan 地址可在高级配置中修改。",
  },
  {
    id: "qwen-sg",
    name: "Qwen · 百炼新加坡",
    protocol: "openai-chat-completions",
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus", "qwen3.5-plus"],
    note: "使用新加坡地域 API Key；不同地域凭据与模型可能不同。",
  },
  {
    id: "kimi",
    name: "Kimi · 月之暗面",
    protocol: "openai-chat-completions",
    baseURL: "https://api.moonshot.cn/v1",
    models: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6"],
    note: "此处为开放平台 API，不是 Kimi Code 订阅端点。",
  },
  {
    id: "glm",
    name: "GLM · 智谱",
    protocol: "openai-chat-completions",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-5.3", "glm-5.3-flash"],
    note: "此处为常规 API；Coding Plan 请在高级配置中填写套餐专属地址。",
  },
];
