# 第 1 轮：Provider、会话与执行链审计

日期：2026-10-03（Asia/Shanghai）。范围：R1-02 的源码审查，以及协调者追加授权的无语音启动和系统文件打开通路收敛。**三个首版协议尚未接入实际桌面请求链；本报告没有真实 API 通过项。**

审查基准为 PersonaCLI/Herta 提交 `8fb809934e0807ee0f0f590d87365a83bb720ca2`。下文“上游”路径及行号均指这一固定提交的实际文件；本地曾从 `.baseline/Herta-8fb809934e0807ee0f0f590d87365a83bb720ca2/` 读取，导入后为同样的 `packages/` 路径。R1 修改后的引用明确标为“当前”。未将上游注释中的历史实测当成本次实测。检查了工作区、上级目录和上游源码中的 `AGENTS.md`，没有发现该文件。

已阅读 README、IMPLEMENTATION_PLAN、DESIGN_SPEC、TASKS、ACCEPTANCE 和 PROVIDERS。公共类型由协调者唯一维护；本审计没有修改 Provider 请求、锁文件、凭据或会话存储格式。

## 1. 三个协议的实际现状

| 首版模式 | 固定上游实际存在的代码 | 桌面实际链路 | R1 验证状态 |
| --- | --- | --- | --- |
| `openai-responses` | 没有 Responses 请求/流事件/工具结果适配器 | 未接入 | 确定性协议用例未执行；真实服务阻塞（无凭据） |
| `openai-chat-completions` | `OpenAICompatibleProvider` 可编码 `messages/tools`，POST `/chat/completions`，读取 `choices[0].delta` | backend 通过 DeepSeek factory 使用它，persona 仍走原始 completion；不等于只配置 OpenAI 就能完整运行 | 本次未验证官方或兼容服务；无独立 OpenAI 真实闭环证据 |
| `anthropic-messages` | 没有 Messages 内容块、独立鉴权头、流事件、工具结果和分页模型列表适配器 | 未接入 | 确定性协议用例未执行；真实服务阻塞（无凭据） |

代码依据：`packages/providers/src/openai-compat/provider.ts:38`、`openai-compat/http.ts:25`、`openai-compat/translate.ts:31`、`openai-compat/stream.ts:8`；上游 `packages/providers/src/index.ts:1` 导出 DeepSeek factories 和 OpenAI compatible chat/completion 两种传输。`/beta/completions` 是原始文本 completion，**不是** OpenAI Responses 或 Chat Completions。

R1 当前新增的 `packages/providers/src/contracts.ts:1` 明确声明只是 R2/R3 的契约。协议名存在于类型声明不能计为协议已经实现。新增类型不会自动改变下文的 DeepSeek 实际链路。

## 2. 桌面请求方向

```text
renderer submit-message
  → HertaBridge.submitText(text, stagedImageIds)
  → preload 固定 channel session:submitText
  → main/session-service.ts 注册的 IPC handler
  → host.activeSession.submitText()
  → session.ts: DeepSeek key gate + single-turn gate + AbortController
  → V2ActorDriver.runTurn()
      ├→ router / supervisor / recap 的 chat provider
      ├→ persona 原始 CompletionProviderAdapter
      └→ @板砖 / runtimeFactory → CodingAgentRuntime
           → backend-turn-loop → ProviderAdapter.streamChat()
           → 完整工具调用 → permission engine → 实际工具执行
           → 工具结果与 call ID 写 transcript → 下一次模型请求
  → 会话 projector → record / overlay / agent / turn subscriptions
  → main startForwarders → preload → renderer session-store
```

入口依据：`packages/gui/src/preload/index.ts:18`；`packages/gui/src/main/session-service.ts:712`；`packages/app-server/src/session.ts:887`；`packages/herta/src/narrative/v2-actor-driver.ts:665`；`packages/core/src/backend/stream-model-inference.ts:85`；`packages/core/src/backend/backend-turn-loop.ts:726`、`:785`；`packages/gui/src/main/session-service.ts:433`。

工具执行和权限控制已有可复用实现；供应商解耦应发生在真实 provider 构造、persona 上下文和 HTTP/流适配层，不能仅替换设置页文字。

## 3. DeepSeek 耦合台账

### 3.1 会影响首版对话和执行的耦合

| 位置（固定上游行号） | 事实 | 必需改造方向 |
| --- | --- | --- |
| `packages/app-server/src/types.ts:57` | 配置只有 `deepseekApiKey`、actor/backend/router 模型和一个共享 `baseUrl` | 多 Provider ID、显式协议、独立 credentialRef 和角色绑定 |
| `packages/gui/src/main/session-service.ts:295`、`:332` | GUI 读取单一 DeepSeek secret；actor/backend 默认分别为 `deepseek-v4-pro` / `deepseek-flash`；router 固定 flash | 按 Provider 解析角色连接；无厂家默认门槛 |
| `packages/gui/src/main/session-service.ts:341`、`:1408` | Base URL 只有开发环境 `HERTA_DEEPSEEK_BASE_URL` override；安装版忽略此环境变量 | 用户正式配置 Base URL，显式选择目标并验证 |
| `packages/app-server/src/session-host.ts:104`、`:366` | host 维护单一可变 key holder，可在运行时替换 | secret 按 Provider ID 隔离；每个 turn 冻结配置/凭据归属 |
| `packages/app-server/src/session.ts:858`、`:894` | `continueInterrupted` 和 `submitText` 均检查 DeepSeek key；否则返回 `needsKey` | 按本轮角色绑定检查缺失配置，允许仅配置任一支持协议 |
| `packages/app-server/src/session.ts:1751` | actor、backend、侧路共用 live key getter；不是本轮配置快照 | 不让活动轮次后续请求读到刚替换的新连接或 key |
| `packages/providers/src/deepseek/factory.ts:33` | backend/chat factory 默认 DeepSeek 域名和模型，并注入 `thinking` / `reasoning_effort` | 协议专属参数按能力启用，不通传厂家参数 |
| `packages/providers/src/deepseek/completion-factory.ts:29` | persona factory 默认 `https://api.deepseek.com/beta/completions` | 原始 completion 只保留为显式旧路径，默认 persona 使用中立消息 |
| `packages/core/src/types/completion-provider.ts:22`、`:36` | persona 契约是原始 `prompt + stop + model` 的 CompletionProviderAdapter；与 chat adapter 分离 | 新 persona 输入为 system、历史与执行器结果，不要求 completion/prefill |
| `packages/app-server/src/session-wiring.ts:738` | actor 默认 `deepseekCompletionProvider` | 接新 persona binding/adapter；不要隐式回退 DeepSeek |
| `packages/herta/src/narrative/v2-actor-driver.ts:115` | 主角色 driver 的 `provider` 类型只能是 CompletionProviderAdapter | 保留角色/执行器分工，替换对话输入与适配层依赖 |
| `packages/herta/src/narrative/actor-prompt.ts:355` | 将角色书页、历史与当前开口序列化成一个原始 prompt | 抽出供应商无关角色上下文；旧格式可作为资料，不要求服务继续特殊开口 |
| `packages/herta/src/narrative/actor-turn-stream.ts:99`、`:160`、`:980` | 专有中文闭合标记 stop 列表、按 completion 行为调温重试、`streamCompletion` | 不把这些 stop/prefill/调温约束强加给另两种协议 |
| `packages/herta/src/narrative/actor-turn-beat.ts:107` | 工具过程中的角色 beat 也用 completion | 必须一并替换；只改最终回答仍残留隐性 DeepSeek 请求 |
| `packages/app-server/src/session-wiring.ts:149` | `createBackendProvider` 始终 DeepSeek factory，固定其 thinking/retry 配置 | executor 绑定显式协议适配器，重用工具权限循环 |
| `packages/app-server/src/session-wiring.ts:743`、`:755`、`:777` | mood router、supervisor 都固定 flash；recap 复用 supervisor adapter | 全部侧路走选定连接或本地规则，不能暗中调用旧厂家 |
| `packages/app-server/src/session-titler.ts:98` | 自动标题固定 flash + thinking low | 标题使用角色绑定或本地标题，不能引入隐性请求 |
| `packages/app-server/src/session-wiring.ts:227` | digest 工具的侧模型固定 flash | 跟随 executor/允许明确侧路绑定，尊重能力和额度 |
| `packages/providers/src/deepseek/vision-factory.ts:26`；`packages/app-server/src/session.ts:2129` | 附件/图片/PDF 描述固定 DeepSeek vision factory | 未实现或能力未知时明确禁用，不默认向 DeepSeek 发图 |
| `packages/app-server/src/session-wiring.ts:177` | `deepseek-flash` 或模型名包含 `vision` 就推断图片能力 | 改用模型能力和实际验证状态；unknown 不启用 |
| `packages/gui/src/main/app-settings.ts:40`、`:54` | ModelChoice 白名单仅 pro / flash；旧型号映射到 flash | string 模型 ID + 模型发现/手填，不强制型号枚举 |
| `packages/gui/src/renderer/ipc/bridge-types.ts:163`；`packages/gui/src/main/settings-ipc.ts:223` | renderer 公共类型和主进程保存校验都拒绝任意模型 ID | 同步改公共类型、主进程运行时校验、设置存储和实际请求链 |
| `packages/gui/src/renderer/components/Settings/DeepSeekSettings.tsx:256` | 下拉只有 pro / flash；没有 Provider CRUD、protocol、Base URL 或手填 | R2 管理界面，R3 真实接线；未接线状态显式标记 |
| `packages/gui/src/renderer/components/Settings/KeyPrompt.tsx:103`；`renderer/lib/submit-message.ts` | needsKey 进入专用 DeepSeek 提示和重发路径 | 按缺失 binding 提示连接；输入保留，不隐藏重试副作用 |
| `packages/gui/src/main/key-store.ts:33`、`:194` | 固定 `deepseek/minimax/minimax-plan` secret 名称；无法存同协议多个 Provider key | 新增稳定 Provider secret 命名和引用，不以显示名作为键 |
| `packages/gui/src/main/settings-ipc.ts:534` | 保存 key 就调用 `validateDeepSeekKey`，没有传配置 URL | 保存新 Provider 不应先把 key 发送给 DeepSeek；测试是显式动作 |
| `packages/providers/src/config/validate-deepseek-key.ts:38`、`:46` | GET 默认 DeepSeek `/models`，仅看状态，不解析可选模型或工具能力 | 独立模型发现和低成本能力测试；列表/鉴权成功不算工具可用 |
| `packages/providers/src/openai-compat/translate.ts:58`；`:185` 附近 | 对 `thinking` 检查和 `reasoning_content` 续写有 DeepSeek 分支 | 私有上下文限定 Provider/protocol/model/revision 归属，禁止跨协议复用 |
| `packages/providers/src/openai-compat/stream.ts:14`；`packages/providers/src/usage.ts:76` | 流接收私有 reasoning_content；用量含 DeepSeek cache hit/miss 字段 | 正文不显示私有推理；中立用量保留可选非通用字段 |
| `packages/core/src/backend/context-budget.ts:7`；`packages/core/src/text/estimate-prompt-tokens.ts:21` | 预算/估算有针对 DeepSeek 的校准假设 | 可先用保守预算；不能声称适用于全部模型上下文/价格 |

UI 中 SettingsModal、settings-snapshot、BanzhuanSettings、Composer、session-store 与中英文 i18n 也有 DeepSeek 名称/状态/型号说明；这些是同一配置门槛的消费者，需要随真实后端契约一起迁移。`packages/gui/src/shared/links.ts:17` 还只有 DeepSeek/MiniMax 等预设外链白名单，新增服务说明需要更新可信外链规则，不应开放任意系统协议。

### 3.2 保留上游工具/CLI、延后功能的耦合

这些并非新的首版要求，但如果仍从 GUI 启用，不能成为绕过 Provider 选择的旁路：

| 位置 | 事实与处理 |
| --- | --- |
| `packages/providers/src/config/resolve-deepseek-key.ts:17`、`:23`、`:26` | CLI 从 `DEEPSEEK_API_KEY`、仓库明文文件、home key 文件读取；GUI 当前没有用这个 resolver。首版 GUI 不得回退到它 |
| `packages/cli/src/app/main.ts:203`、`:225`、`:386` | CLI 独立 DeepSeek key 解析、actor completion 与默认型号；保留上游 CLI 不代表桌面多 Provider 已实现 |
| `packages/app-server/src/session-host.ts:254` | 可选 dream 使用 `RealDeepSeekClient` 和同一个 key holder；开启前必须解耦或在个人版保持关闭 |
| `packages/knowledge/src/llm/deepseek-client.ts:37`、`:63`、`:87` | 独立 JSON chat client 固定域名、`/v1/chat/completions` 和 Bearer；与 GUI provider transport 不同，Base URL 含 /v1 会重复 |
| `packages/knowledge/src/llm/key-resolver.ts:21`；`packages/knowledge/src/paths.ts` | knowledge tooling 有 `HERTA_DEEPSEEK_API_KEY` 和本地秘密文件路径 |
| `packages/knowledge/src/dream/config.ts:51`；`knowledge/src/voice/run-restratify-llm-pass.ts:13` | dream/voice 离线资料处理默认 pro；不自动运行、下载或请求 |
| `packages/knowledge/src/cli/herta-knowledge.ts:357`、`:598`、`:1200`、`:1578`；`cli/self-model-subcommand.ts:723` | ingest、voice 分层、persona seed/self-model 等 CLI 实际构造 DeepSeek client；可保留，不能拿它们当作 GUI 三协议路径 |
| `packages/knowledge/src/self-model/run-extract-pass.ts`、`run-judge-pass.ts`、`run-synthesize-pass.ts`；`dream/llm-json.ts`、`reconsolidation-junction.ts`、`novelty.ts`、`semanticize.ts` | 接受专用 DeepSeekClient/响应/形状错误类型；属于延后资料/记忆链。重新启用时一起迁移 |
| `packages/knowledge/src/llm/cost-estimator.ts:14`；`ingest/run-llm-claims-pass.ts:137`、`ingest/ingest-corpus.ts:322`、`voice/run-restratify-llm-pass.ts:210` | 固定价格模型和 `provider: deepseek` provenance；不能直接用于多供应商计费/来源 |

`tools/src/bash/index.ts`、`core/src/types/tool.ts`、`app-server/src/attachments.ts`、`image.ts`、`usage-log.ts`、`gui/src/main/net-transport.ts` 等还有供应商背景注释、图片格式假设或历史例子。文字提及不是新的网络出口；其中图片能力与用量的真实行为已在上表列出。`tools/src/run-command/redactor.ts:28` 对 DEEPSEEK_API_KEY 的提及是通用秘密脱敏示例，应该保留并扩大覆盖，而非移除安全保护。

## 4. 已有会话、事件、取消和审批语义

| 项目 | 实际语义 | 后续必须保持/补足 |
| --- | --- | --- |
| 单轮互斥 | `session.ts:904` 主进程拒绝同会话第二个 turn；不是仅靠 UI 禁用 | 新适配器不另开不受控 turn |
| submit 返回 | `submitText` await 整轮完成后才返回 turnId（`:911`、`:955`）；开始由 lifecycle 实时通知 | UI 不把 invoke 返回当“已接收”或“已开始”的唯一事实 |
| lifecycle | `runAsTurn` 发 started / finished / failed；AbortError 也是 failed 的一种（`:638`–`:703`） | 统一 UI 可将 AbortError 映射 cancelled，不能显示成功；stopping 等中间展示可从请求状态派生 |
| record | block/reset/dropped；可请求完整尾部快照并按绝对索引分页（`types.ts:357`、`session-service.ts:366`） | 保持权威快照和 resync；扩充会话/轮次/序号归属 |
| 事件归属 | 当前多条事件只带 blockId/requestId/turnId，没有统一 sessionId/seq；只转发当前活动 session（`types.ts:357`、`:387`、`:404`） | R3 为跨会话和重载提供明确 envelope；当前结构不能假称支持多活动会话 |
| 切会话 | activationSeq 只让最新点击指向会话；旧 forwarders 关闭；host 切换会关闭当前 session 并中断其轮次（`session-activation.ts:67`、`:113`；`session-host.ts:458`） | UI 明确切换会停止活动会话；不要伪装后台并行 |
| Stop | 核对可选 turnId，然后 abort（`session.ts:1097`）；返回 ok 只表示收到中断，不代表已完成进程清理 | 等最终事件再显示已停止；已有磁盘改动不会撤销 |
| 工具参数流 | 分 index 缓冲，只有 tool_calls finish 后产出完整 request；断流丢弃未完成参数（`providers/.../stream.ts:86`、`:129`、`:153`） | 三协议各自测试分块、多工具、重复事件和结束原因 |
| 非法参数 | JSON parse 失败成为 malformedArgs 数据；循环不执行此调用而回传可修复错误（`stream.ts:185`；`backend-turn-loop.ts:575`） | 新契约的 ready 事件要在完整 JSON/schema 验证后发出；不要执行 delta |
| 真实权限 | backend loop 先 permissions.check/present 再 tools.run；拒绝作为 tool failure 返回模型（`backend-turn-loop.ts:216`、`:255`、`:726`、`:785`） | Provider adapter 不执行工具、不绕过这里 |
| 单项审批 | OverlayAskResolver 保留请求对象，核对 requestId；长期规则从待批真实请求推导，不能由 renderer 自造（`overlay-ask-resolver.ts:81`、`:200`、`:216`） | 默认 UI 单次允许/拒绝；长期授权独立设置，并补 session/turn 归属 |
| 等待审批取消 | abort 清 pending、清 overlay、reject AbortError；旧 ID 返回 no_pending/stale（`overlay-ask-resolver.ts:130`、`:200`） | 取消不伪造用户拒绝；race/旧审批需确定性与真实无副作用测试 |
| Windows 子进程 | runner 用 taskkill /T /F；persistent bash 也有树清理与 MSYS 处理（`tools/src/run-command/runner.ts:24`、`:58`；`bash/persistent-shell.ts:738`） | 源码机制存在不等于本机取消通过；须实际进程树验收 |
| 持久化 | JSONL version 1，增量 block、workspace_set、turn_end；损坏尾行容错；标题/主题和 dispatch journal 独立存储（`core/src/session-io/v2-record-persister.ts:102`、`:233`；`read-session-file.ts:152`、`:221`） | 保留格式；新增 Provider 引用/快照的迁移需版本、备份、失败回退 |
| 副作用日志 | 非只读调用先 durable dispatch，再执行；启动按 PID+start time 回收旧进程（`backend-turn-loop.ts:753`；`app-server/src/dispatch-recovery.ts:76`） | 无确认结果时显示“可能执行”，不自动重试副作用 |
| 崩溃恢复 | openSession 先 sealOpenDispatch，写中断 marker 和 turn_end（`session-host.ts:465`）；旧 orphan 自动生成仍存在（`session-activation.ts:139`、`session.ts:989`） | 自动生成仅靠末尾 user/无结束标记；无 journal、落盘失败等残余情况要保持只读恢复，R1 个人版由桌面职责关闭该入口 |

`recordTurnEnd` 写盘异常会被吞掉（`session.ts:976`），本进程仍有内存保护，但重启后的状态依据可能不完整。已有 `continueInterrupted` 和 journal seal 不应被简化成重跑原用户消息；R3 需要把未决副作用、已完成工具和用户手动恢复分别展示。

## 5. IPC、路径与凭据边界

已存在的安全基础：主窗口 contextIsolation=true、nodeIntegration=false、sandbox=true（上游 `gui/src/main/index.ts:324`）；preload 只暴露固定业务函数，不暴露任意 ipcRenderer/fs/shell；新窗口和导航受限制（`:128`、`:358`）。文件读取核对 session 并 realpath 到工作区边界，工具路径还保护秘密文件和 `.herta` 状态（`gui/src/main/read-workspace-file.ts:76`；`tools/src/path-safety.ts:458`；`validate-workspace-root.ts:159`）。Markdown/文档预览经 DOMPurify，去掉可自动导航的 href，Mermaid 使用 strict（`renderer/components/FileViewer/renderers/dom-html.ts:17`、`:39`；`mermaid-render.ts:3`）。这些是源码审查事实，尚非 S02/S03 动态通过。

| 缺口/变化 | 代码依据与实际影响 | 本轮处理/状态 |
| --- | --- | --- |
| IPC sender 没统一校验 | 上游 `session-service.ts:689` wrapper 不校验 event.sender / senderFrame；settings/window 全局 handler 也未统一检查来源 | R3 S02 要加主 frame/可信窗口验证；目前只有已有 sandbox/navigation 基础 |
| 运行参数校验不一致 | `submitText` 直接读 text.length；`setDeepSeekKey` 直接 key.trim；resolveApproval 直接用 opts 字段（`:714`、`settings-ipc.ts:528`、`session.ts:1329`） | TS 类型不阻止非法 IPC；需 schema/大小限制/枚举校验与稳定错误 |
| 部分命令依赖活动会话 | submit/interrupt/approval/trust/rules 没有 sessionId 参数；不同于读文件/工作区设置（`preload/index.ts:18`、`:39`；`session-service.ts:891`） | 给实际变更接口增加 session/turn 归属；旧 requestId 已有 stale 校验但不能代替归属 |
| OS 打开可执行文件 | 上游 `session-service.ts:1154` 将任意 jailed path 交 shell.openPath；工作区内 exe/cmd/bat/lnk 等仍能执行，绕过工具审批 | **R1 已关闭**此 IPC，抛出明确“本轮仅支持应用内只读查看文件，请使用文件预览。”；当前 `session-service.ts:1157`，已移除 shell import。保留真实应用内读取 |
| 安全存储失败明文回退 | 固定上游 `key-store.ts:135` 会写 `.txt`；Windows POSIX mode 不构成保护 | 桌面职责当前 `key-store.ts:132` 已改为安全存储不可用时失败并保留旧值；只读迁移旧 .txt 仍需后续策略 |
| 删除 secret 是 best effort | `key-store.ts:44` 捕获 rm 失败；状态可能仍有旧文件 | R3 S01 应验证实际删除/读不回旧值，并向用户反馈文件锁导致失败；本次未动态测 |
| 原始服务错误可进入日志/renderer | `retry-post.ts:109` 解析外部 error.message；`session-service.ts:750` 打印 err；`session.ts:682` 发 error payload | 网关可能在错误中回显秘密；需使用本轮 secret 脱敏及有界诊断，不把原始 payload 当安全日志 |
| URL 和重定向没有正式安全层 | chat 仅去一个尾斜杠追加路径（`http.ts:36`），Bearer fetch 未显式设置 redirect policy（`retry-post.ts:74`）；key 测试另拼 /models | 正式配置需拒绝内嵌凭据、秘密查询、错误完整端点；保留 prefix；跨源拒绝转发鉴权；本次没有可证明泄密的网络实验 |
| 活动 key 没冻结 | host getter 每次请求解析 secret；改 key 可以影响同一轮后续工具续写请求（`session-host.ts:366`；`session.ts:1751`；`retry-post.ts:52`） | TurnProviderSnapshot 要真正构造/冻结后才能宣称配置冻结成立 |

renderer 中新输入 key 会通过特定保存 IPC 传给 main，这属于用户输入通路；**已保存 secret 没有读取明文回 renderer 的方法**。既有 masked status 返回最后四字符，但该状态只能证明保存状态，不能证明模型文本或工具可用。

## 6. 当前最小公共契约及待接线约束

协调者已维护 `packages/providers/src/contracts.ts`，并在 `PROVIDERS.md` 解释 R1 未接线状态：

| 契约 | 对应源码 | 审计意见 |
| --- | --- | --- |
| ProviderConfig / ProviderSettings | `contracts.ts:42`、`:73` | 稳定 id、可改 name、显式 protocol/baseURL、credentialRef、authentication、remote HTTP opt-in、models/defaults/revision；普通配置无密钥值 |
| 模型能力与验证 | `contracts.ts:10`、`:11`、`:24` | 三态能力与 unverified/text/tools/failed 分开；按 protocol+revision 失效；发现不等于可用 |
| 角色绑定 | `contracts.ts:62`、`:67` | persona/executor 都绑定 Provider+model；默认共用，executor 需匹配工具验证 |
| 每轮快照 | `contracts.ts:81` | 构造并 deep-copy/freeze 是 R3 实现义务；readonly interface 本身不是运行时隔离 |
| 中立上下文 | `contracts.ts:89`、`:103`、`:111` | system、历史文本/工具 call/result、signal；native opaque 有 provider/revision/protocol/model 归属，不要求 completion/prefill |
| 中立流与模型分页 | `contracts.ts:127`、`:149`、`:156` | text、tool args delta、完整 ready、usage、finished；错误抛标准 ProviderError，abort 不算 finished；listModels 保留 cursor |

R3 的最小接线顺序：先实现每个协议的消息/鉴权/流/工具结果和 URL 拼接；再让 persona、executor 及全部必要侧路读取冻结 binding；再落地 Provider/secret 管理和能力验证。使用统一工厂时不得从域名、显示名或模型前缀猜协议，不自动换 Provider 重试已执行工具的轮次。旧 DeepSeek 设置迁移需备份并保留历史。

## 7. 无语音启动修复和本次验证

上游 `session-service.ts:1279`–`:1397` 会在每次 bootstrap 创建 local TTS、voice model 下载服务、MiniMax voice/synthesizer 和 switching synthesizer；已有云语音设置和 key 时还会自动 prepare clone（`:1374`）。未提供 voice/TTS 资源时，不应只跳过打包检查而保留这些启动路径。

协调者追加授权后，本报告作者只修改 `packages/gui/src/main/session-service.ts` 和新增 `session-service.personal.test.ts`：

- 当前 `session-service.ts:1274` 仅在 `PRODUCT_PROFILE.voice` 为 true 时构造上述服务；false 不注入 speech/voiceRoot，不构造 MiniMax fallback transport，realtime 以 profile 为 false 起始。普通 locale、attention、settings 和 session host 仍初始化。
- 当前 `session-service.ts:1157` 关闭 OS 文件打开 IPC。应用内 readWorkspaceFile/readWorkspaceDiff 路径没有被删除或替换成 mock。
- 新测试明确是单元控制验证：给出“保存的 realtime voice=true、engine=minimax、已有假 key”的条件，实际执行 bootstrap，检查所有语音工厂/transport/root 均未调用、host config 没有 speech；另通过实际已注册 IPC listener 检查 exe/cmd/bat/lnk/普通源文件全部拒绝，shell.openPath 未调用。

| 检查 | 实际结果 | 证据/限制 |
| --- | --- | --- |
| `biome format --write` 两个自有文件 | 通过，exit 0 | 工具输出为 2 files；格式检查不是产品功能通过 |
| 固定 Node 22.23.3 下 `tsc -p packages/gui/tsconfig.node.json --noEmit` | 通过，exit 0 | 2026-10-03 21:47，主进程类型检查；不代表 Electron 运行通过 |
| `vitest run packages/gui/src/main/session-service.personal.test.ts` | 通过，2/2，exit 0 | 21:47:52 起，3.20 s；stdout 为 launch connect screen；使用 mocks，仅证明本地启动/IPC 分支控制 |
| 首次上述测试/类型检查 | 曾阻塞 | app-server dist 尚未构建；构建完成后上述独立项已通过 |
| 既有 `session-service.test.ts` 回归尝试 | 曾阻塞 | 21:46 尝试导入 electron 自动下载 binary 失败，suite 未执行断言；需桌面集成补测 |
| 三协议确定性适配测试 | 未执行 | 本轮只冻结契约，没有三个新适配器 |
| 三协议真实 API、真实工具、取消/审批副作用 | 阻塞 | 没有本地可用服务凭据；没有向服务发请求，也没有用一家成功代表三家 |
| Electron exe/安装包真实启动 | 本子任务未执行 | 由协调者记录在 `docs/reports/round-1.md`；本单元测试不替代 D01/R03/R04 |

测试命令使用协调者固定运行时：先把 `.runtime/node-v22.23.3-win-x64` 加入当前进程 PATH，再调用 `node .runtime/pnpm/node_modules/pnpm/bin/pnpm.cjs exec ...`。未修改依赖或锁文件。集成日志和真实截图最终位置以 round-1 报告为准；本报告不虚构截图。

## 8. 下一轮交接

1. R2 依据冻结契约构建 Provider CRUD、协议/Base URL/secret 状态、模型发现入口和手填、角色绑定界面。任何未接线操作明确标记；无 key 仍可浏览与读取历史。
2. R3 一并替换 persona completion 和全部必要侧路，分别完成 Responses、Chat Completions、Messages 的确定性及真实服务闭环；缺少哪个凭据就单列阻塞，至少一个非默认 URL 实测。
3. 同步补 session/turn 事件归属、sender/参数校验、每轮配置冻结、删除密钥失败反馈、断流与手动恢复、真实 Windows 子进程清理。保留 permission engine、journal 和真实只读预览基础，不重写成模拟工具。

本报告确认的是源码存在性和本轮有限修复；仍不满足第三轮 A01–A08/V01–V06/P01–P02/S01–S03 的完成标准。
