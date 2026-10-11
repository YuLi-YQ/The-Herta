# 服务商预设

核对日期：2026-10-08。预设只填配置；模型列表可能随账户、地区和服务更新变化，可显式获取列表或手填。思考强度在输入区调整，只显示已支持型号的选项。普通保存不联网，验证与获取模型是显式操作。

| 服务 | 协议 / 地址 | 官方依据 |
| --- | --- | --- |
| OpenAI | Responses · `https://api.openai.com/v1` | [模型](https://developers.openai.com/api/docs/models/all)、[获取模型](https://developers.openai.com/api/reference/resources/models/methods/list) |
| Anthropic | Messages · `https://api.anthropic.com/v1` | [API](https://platform.claude.com/docs/en/api/overview)、[型号](https://platform.claude.com/docs/en/models/overview)、[思考强度](https://platform.claude.com/docs/en/build-with-claude/effort) |
| Gemini | Chat Completions · `https://generativelanguage.googleapis.com/v1beta/openai` | [兼容接口](https://ai.google.dev/gemini-api/docs/openai) |
| DeepSeek | Chat Completions · `https://api.deepseek.com` | [思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)、[Responses](https://api-docs.deepseek.com/guides/responses_api/) |
| Qwen 北京 | Chat Completions · `https://dashscope.aliyuncs.com/compatible-mode/v1` | [兼容接口与地区](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)、[思考开关](https://help.aliyun.com/zh/model-studio/deep-thinking) |
| Qwen 新加坡 | Chat Completions · `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | 同上；Key 必须匹配地区；若账户要求工作空间专属端点，可在高级配置修改 |
| Kimi | Chat Completions · `https://api.moonshot.cn/v1` | [接入](https://platform.kimi.com/docs/get-api-key)、[思考强度](https://platform.kimi.com/docs/guide/use-reasoning-effort) |
| GLM | Chat Completions · `https://open.bigmodel.cn/api/paas/v4` | [兼容接口](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction) |

Google Antigravity 是单独的代理开发产品，提供账号与 SDK 等接入方式，不作为虚构的统一 Key/Base URL 预设。本版展示说明；持有 Gemini API Key 时可转入 Gemini 配置。这不会使用 Antigravity 的账号凭据或订阅额度。依据：[安装与认证](https://antigravity.google/docs/cli/install)、[SDK](https://www.antigravity.google/docs/sdk/overview)。

新预设默认请求超时 120 秒；已有连接不自动覆盖。文本模型通过文本验证后可用于聊天；编程执行器仍要求工具能力验证。模型发现成功不等于工具调用已通过。
