# Provider 与模型接入规范

状态：2026-10-04。第二轮实现配置持久化、加密凭据和绑定；第三轮已接三协议请求、模型发现、能力验证及迁移，第四轮统一审查补齐配置回读、响应资源边界与桌面隔离。真实验证仅为 DeepSeek 兼容服务的 deepseek-flash，不代表官方 OpenAI/Anthropic 或真实旧用户资料迁移通过。范围与证据见 reports/round-3.md、reports/round-4.md。

R1 将配置/能力/角色绑定/turn 快照/消息与协议适配边界冻结为 `packages/providers/src/contracts.ts`，由协调者维护。契约文件本身只有类型；实际实现位于 protocols 与桌面 neutral-driver / SessionHost 链路，不能仅凭设置页或类型定义声称协议通过。上游历史耦合见 `PROVIDER_AUDIT.md`，统一审查见 `reports/final-review.md`。

契约要求：`ProviderSettings.schemaVersion = 1`；配置只持有 `credentialRef`，密钥解析在主进程；`revision` 正整数，URL/Key/协议变化使验证失效；模型支持 unknown/supported/unsupported 与 unverified/text-available/tools-available/failed 分开。`TurnProviderSnapshot` 在开始时深复制冻结。`NeutralMessage` 不携带 DeepSeek reasoning 字段；私有 `NativeContext` 限定 providerId/revision/protocol/modelId，不跨协议复用。`tool-arguments-delta` 永不执行，只有完整 JSON/schema 校验后的 `tool-call-ready` 才交权限引擎；协议流异常抛 ProviderError，取消不产生 finished。R3 在复用现有 ProviderAdapter 的工具执行消费点时要维护 call ID 并增加映射测试，不平行发明另一套工具引擎。

## 1. 配置范围

Provider 是用户保存的一组服务连接，不等于协议或模型厂商。允许多个相同协议的 Provider，例如官方 OpenAI、自建 OpenAI 兼容网关、Anthropic 兼容网关；名称由用户自定义。

| 字段 | 要求 |
| --- | --- |
| id / name | 稳定内部 ID 与可编辑显示名，名称变更不影响会话引用 |
| protocol | `openai-responses`、`openai-chat-completions`、`anthropic-messages` 三种显式模式；界面先选 OpenAI / Anthropic，再显示对应模式 |
| baseURL | 用户可编辑的 API 根地址，保留网关路径前缀；清晰展示最终请求地址示例 |
| credentialRef | 指向主进程安全存储中的 API Key；普通配置文件只保存引用 |
| models | 从服务发现或用户手动添加的模型 ID、可选别名、能力与验证状态 |
| defaults | 默认模型、超时和受支持的生成参数；不把某厂商参数直接传给另一协议 |
| revision | 配置版本，用于执行轮次冻结、更新和恢复诊断 |

官方预设只用于填表，用户始终可改 Base URL。不得根据显示名、域名或模型名前缀隐式选择协议。不预置真实密钥，不将任何模型 ID 作为唯一合法白名单。首版范围不包含 Azure/Bedrock 等独立鉴权协议；兼容服务只要遵守已实现协议即可配置，具体兼容性由验证结果说明。

## 2. 协议适配与统一执行

OpenAI Responses 与 Chat Completions 的请求和事件结构不同，应分别适配；官方新项目可优先 Responses，兼容网关可明确选择 Chat Completions。[OpenAI 官方接口迁移说明](https://developers.openai.com/api/docs/guides/migrate-to-responses)

Anthropic 使用独立 Messages 适配器，处理自己的系统消息、内容块、流事件、工具调用/结果、停止原因与鉴权头；不得通过替换 Base URL 假装已支持。[Anthropic Messages 文档](https://platform.claude.com/docs/en/api/messages/create)

内部统一请求表达历史消息、角色约束、工具定义、能力选项和取消信号；统一事件表达文本增量、工具调用 ID/参数增量、完成原因、用量、错误。此处是待设计的抽象，不假称上游已有这些类型。保留各协议恢复所需的原生不透明字段并限定其 Provider/模型归属，不把私有推理字段作为正文显示或跨协议硬转。

工具参数流必须在完整结束且校验通过后才可执行；保持工具调用与结果的 ID 对应关系，处理多工具调用、非法 JSON、断流和重复事件。禁止自动切换协议/Provider 并重试已经执行过工具的轮次。主进程仍是权限控制边界，适配器不能绕过审批直接执行本地操作。

## 3. 解除角色层的 DeepSeek 依赖

将 persona 的角色约束、对话记录与执行器结果构建为供应商无关上下文，再由适配器编码为各协议。保留黑塔与执行器分离，但不要求服务支持原始 completion、assistant prefill 或某个专有停止标记。

必须验证仅配置 OpenAI 或仅配置 Anthropic 时，均可完成角色回复→调度执行器→工具结果→角色结论。不允许后台暗中请求 DeepSeek。旧的 completion 机制可以保留在显式启用的兼容路径中，不作为默认链路或备用服务自动使用。

默认“黑塔对话”和“编程执行”共用一个 Provider + model；高级设置允许独立选择。执行模型必须有经验证的工具能力；对话模型不支持工具时可仅用于角色输出。跨角色混合配置也需测试，不能只测分别聊天成功。

## 4. Base URL 与凭据

Base URL 约定为含版本/网关前缀的 API 根地址，如 `https://api.openai.com/v1`、`https://api.anthropic.com/v1` 或 `https://gateway.example/prefix/v1`。适配器按模式追加 `responses`、`chat/completions` 或 `messages`，不得重复 `/v1`、丢失前缀，或依赖 SDK 不同默认拼接行为。用表驱动测试覆盖尾斜杠、前缀和粘贴完整端点；完整端点输入应提示修正，不能静默猜测。

主进程发起请求，不启用浏览器直连或让用户关闭 CORS 保护。HTTPS 为默认；本地 HTTP 可用于本地服务，远程 HTTP 必须显式选择并说明密钥明文传输，不能自动降级。拒绝 URL 内嵌用户名、密码和密钥查询参数。跨源重定向不得携带凭据。

密钥按 Provider ID 单独保存、替换和删除。编辑 Base URL 时不发送网络请求；目标来源变更后将连接标为未验证，并由用户显式测试/使用该目标。不得向其他 Provider 复用密钥，日志仅显示脱敏配置。首版不提供任意鉴权脚本；无鉴权本地服务可选择“无需 API Key”，该模式不能自动应用于官方服务。

## 5. 模型发现与可用性

支持“获取模型”和“手动添加模型 ID”。按适配器实现模型列表请求、分页及缓存；Anthropic 的模型列表是独立 API，不能沿用 OpenAI 的响应解析。[Anthropic 模型列表文档](https://platform.claude.com/docs/en/api/models/list)

网关可能没有列表接口、返回 403/404 或只列部分模型；这时允许手动输入，不阻断保存。模型列表不能证明该账户一定能生成或调用工具。每个 Provider + model + protocol 记录“未验证 / 文本可用 / 工具可用 / 验证失败”，配置版本变化后失效。模型能力 unknown 不等于 supported。

提供低成本文本测试和单独工具能力测试；后者使用应用内无副作用测试工具，不读取用户项目。测试可能消耗 API 额度，按钮附近简短说明。运行成功也可更新对应能力记录。流式、图片、推理参数及上下文长度按真实能力启用，不硬猜模型前缀，不用模型列表推断价格。

## 6. 切换、持久化与迁移

保存全局默认绑定和会话绑定；每次 turn 开始时冻结 Provider ID、配置版本、模型及参数。本轮结束前切换只影响下一轮，不让流事件混用新配置。删除被当前运行使用的 Provider 时阻止并提示先停止；删除后保留历史文本和非秘密元信息，关联会话要求重新选择连接。

历史采用中立消息与工具记录；切换协议后重新构建上下文，不携带前一服务的会话/响应 ID、签名或私有内容块。无法转换的内容明确标示或要求新建会话，不能悄悄丢失关键工具结果。应用重启不自动重放未完成调用。

迁移旧 DeepSeek 设置时创建对应 Provider、迁移安全存储引用与角色绑定；先备份配置，失败可回退，不清空历史，也不把密钥写入迁移日志。界面移除“没有 DeepSeek Key 就无法运行”的全局门槛。

## 7. 实施与验证范围

R1 核查上游所有 DeepSeek 硬编码、冻结配置/能力/适配器契约；R2 完成 Provider 管理和角色模型选择；R3 完成三个协议模式、角色解耦、模型发现与实际闭环；R4 在安装包复验。

三个模式各自进行确定性协议测试和真实服务闭环测试，至少一个用户配置的非默认 Base URL 完成实测；缺少某一类账号时标记阻塞，不能用另一种协议成功代表全支持。额外覆盖 URL 前缀、模型列表不可用、手填模型、工具不支持、密钥隔离、跨协议切换、旧配置迁移以及只配置一种协议时的独立运行。

2026-10-04 R3 实际登记：三个模式在用户授权的同一兼容服务上分别完成真实任务/工具闭环；Responses 角色与 Messages 执行器混合实测。模型为 deepseek-flash，其他模型及官方服务没有据此获得通过状态。Messages 列表不可用时保留手填；图像/视觉未启用。迁移仅合成旧数据测试，真实旧数据升级待补。详见 [第三轮报告](reports/round-3.md)，历史 R1/R2 审计记录仍保留。

2026-10-05 R6：保存连接不自动发请求或绑定；显式验证后设置当前任务/全局模型。主进程 getProviderReadiness 依据实际 sessionId 的覆盖/默认绑定、加密凭据、协议能力及 revision 决定就绪，submit 再校验；配置变更使旧验证过期。失败只输出有限类别、阶段与安全 HTTP 状态，不向 UI 转发原始响应或密钥。三个模式分别在 DeepSeek 兼容服务 deepseek-flash 完成真实工具请求，详见 reports/round-6.md；官方服务、其他模型仍未测。本地超时/断流/503 与确定性协议测试单独登记，不能计作真实远端 API 通过。

