# 连接、模型与协议

Provider是一组用户保存的服务连接，不等于模型厂商。应用支持显式选择以下协议，并保留服务地址的版本或网关路径前缀：

| protocol | 请求接口 | 例子 |
| --- | --- | --- |
| openai-responses | responses | https://api.openai.com/v1 |
| openai-chat-completions | chat/completions | https://api.deepseek.com |
| anthropic-messages | messages | https://api.anthropic.com/v1 |

预设和地区地址见[服务商预设](PROVIDER_PRESETS.md)。Gemini预设使用其OpenAI兼容接口，不表示实现了Gemini原生协议。自建兼容服务可手填；界面名称不能替代协议选择，模型列表存在也不代表账号可调用。

## 保存与验证

在设置的“连接与模型”中填写连接、密钥和模型。保存与显式验证是不同操作；“保存并验证”按聊天或编程用途执行文本/工具检测。聊天要求当前连接的text-available或tools-available；执行模型要求tools-available。图片需另点“测试识图”，其生成测试图和实际答案匹配后才记录能力，文本/工具通过不自动授予识图。

验证记录绑定protocol、providerRevision和checkedAt。更换地址、协议、鉴权或密钥会使旧连接的验证失效；不改变连接的改名、默认选择等按实际保存规则保留结果。鉴权/临时网络失败与明确能力拒绝分开；未完整返回的检测不应抹掉已有结果。识图日期、连接变化和过期提示可供手动复核，不会后台持续发送付费探测。

实际带图请求收到400/415/422时标记识图待复核，但不臆断全部原因；413另说明请求过大。失败不会通过自动重发已执行工具的回合来掩盖。默认模型与工作台黑塔/执行器绑定可分开；独立聊天在自己的输入区选择，不隐式获得工作区权限。

## 主进程数据契约

| 字段/类型 | 作用 |
| --- | --- |
| ProviderSettings.schemaVersion = 1 | 保存连接与角色绑定；普通配置不含明文密钥 |
| id / name | 稳定内部标识与显示名 |
| protocol / baseURL | 显式协议和API根地址，不接受URL中夹带用户名、密码或密钥 |
| credentialRef | 只引用主进程凭据存储，密钥不传给renderer或插件 |
| models | 模型ID/别名、来源、独立能力与验证状态 |
| defaults | 默认模型、超时和支持的生成选项 |
| revision | 正整数；冻结当前请求所用连接版本 |
| TurnProviderSnapshot | 开始回合时深复制冻结的persona/executor配置与绑定 |
| NativeContext | 限定providerId/revision/protocol/modelId的私有协议续接数据，不跨连接复用 |

能力unknown/supported/unsupported与模型验证unverified/text-available/tools-available/failed是两组不同状态。请求途中改配置只影响后续请求，迟到验证不能覆盖新配置。

## 请求与工具边界

统一适配器处理文本、图片、工具定义、调用ID、参数增量、完成原因、用量和取消。tool-arguments-delta只是显示数据；只有完整JSON和schema校验通过的tool-call-ready才可交给权限引擎。工具结果与调用ID对应，不把流片段、重复事件或模型文字当作已执行操作。

主进程发起请求，默认HTTPS；本地HTTP服务与明确允许的远程HTTP分别处理，不能自动降级TLS。Base URL如https://gateway.example/prefix/v1会保留prefix，再追加当前协议端点。适配器不能绕过本地权限，也不会为恢复失败自动换服务/协议重放工具。

桌面模型传输使用Chromium网络栈及系统信任；插件network.request是另一条受限宿主网络能力，见[插件联网](PLUGIN_NETWORK_V1.md)。关闭模型搜索不等于禁用模型请求，也不会撤销已授予插件的网络能力。

## 当前验证范围

已在一个DeepSeek Flash服务上验证真实工具/识图、聊天与工作台单图及历史多图、执行器直接识图和结果转交、两种摘要，以及一个真实生成插件包。其他服务商、官方OpenAI/Anthropic端点及协议组合不能据此自动标成通过；请按自己的连接显式验证。模型返回的用量/缓存/上下文数据缺失时如实显示未知，不以猜测补齐。

源码入口：[契约](../packages/providers/src/contracts.ts)、[协议编码](../packages/providers/src/protocols/encode.ts)、[模型验证](../packages/gui/src/main/provider-probes.ts)、[工作台驱动](../packages/app-server/src/neutral-driver.ts)。
