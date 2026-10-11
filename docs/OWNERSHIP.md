# 第 1 轮文件所有权与仓库地图

基线：PersonaCLI/Herta `8fb809934e0807ee0f0f590d87365a83bb720ca2`。实际目录已导入；本文件不是虚拟路径规划。当前没有发现任何 AGENTS.md（工作树、上游及适用父目录均查找）。

## 本轮所有权

| 负责人 | 独占写入 |
| --- | --- |
| 协调者 | 根配置/锁文件、README、公共契约、gui/package.json、electron.vite.config.ts、shared/product-profile.ts、main/key-store.ts 与 key-store.test.ts、docs/OWNERSHIP.md、UPSTREAM.md、PROVIDERS.md、reports、集成验证脚本 |
| desktop_baseline | main/index.ts、update-service.ts、app-global-settings.ts、settings-ipc.ts/test、tray.ts、新增个人模式测试、electron-builder*.yml、scripts/check-personal-payload.mjs、docs/DESKTOP_BASELINE.md |
| ui_assets_baseline | renderer/**、resources/**、build/**、assets/ASSET_MANIFEST.md、docs/ASSET_AUDIT.md |
| provider_audit | docs/PROVIDER_AUDIT.md；后续明确授予 main/session-service.ts（语音初始化隔离）及其个人模式测试 |

消费者只能读取公共契约；接口由协调者唯一维护。子代理不修改依赖或锁文件。所有改动在同一工作树，协调者检查差异并执行最终桌面/安装验证。

## 实际入口与处理状态

| 区域 | 实际文件 | R1 状态 |
| --- | --- | --- |
| 桌面启动/窗口/生命周期 | packages/gui/src/main/index.ts | 已存在；改独立名称、数据目录、关闭上游更新与可选媒体 |
| IPC 通道与受限桥接 | packages/gui/src/preload/channels.ts、index.ts；renderer/ipc/bridge-types.ts | 已存在；本轮沿用，禁止媒体 IPC 生效；新增 Provider IPC 留到 R2/R3 |
| 桌面配置/凭据 | main/app-global-settings.ts、app-settings.ts、settings-ipc.ts、key-store.ts | 已存在；原 DeepSeek/固定模型；修复新密钥明文保存回退 |
| GUI 与展示状态 | renderer/App.tsx、state/session-store.ts、components/ | 已存在；R1 最小去媒体/抽象图标，R2 重设计 |
| 会话主进程宿主 | main/session-service.ts → packages/app-server/src/session-host.ts、session.ts | 已存在；session 事件保留，R1 不称多 Provider 可用 |
| 人格/执行器 | packages/herta/src/persona.ts；packages/core/src/backend/ | 已存在；人格 completion 依赖需 R3 替换，工具引擎优先复用 |
| Provider | packages/providers/src/deepseek/、openai-compat/ | 已存在；只有旧 Chat/Completion，Responses/Anthropic 需新增 |
| 新 Provider 公共类型 | packages/providers/src/contracts.ts | R1 新增并冻结；仅类型，不是协议实现 |
| 权限/工具/持久化 | packages/core/src/permission-engine.ts、approval-policy.ts、session-io/；packages/tools/src/ | 已存在；需 R3 真实流程和 Windows 取消/路径验证 |
| 打包 | packages/gui/electron-builder.personal.yml、scripts/check-personal-payload.mjs | R1 新增个人无语音 Windows x64；保留 notices 门槛 |
| 第三方告知 | LICENSE、THIRD-PARTY-NOTICES.md；gui/scripts/third-party-notices.mjs | 保留并按实际 bundle 重新生成/检查 |
| 素材 | renderer/public、renderer/upstream-assets、gui/resources、gui/build | 自绘几何替换；源角色/3D资源留作审计且不进个人包 |
| website | website/ | 保留 workspace 引用，不是本项目交付；未部署 |

更细的调用方向、DeepSeek 耦合、安全缺口和事件语义见 PROVIDER_AUDIT.md。R1 不新增并行会话事实源，复用 app-server 的 Record/Turn/Agent/Overlay 事件，以真实 sessionId 关联。

## 第 2 轮独占范围（2026-10-04）

保留第 1 轮记录，新增本轮分工。协调者唯一维护 shared/provider-settings-ipc.ts 公共请求与view契约；providers/contracts.ts 原契约不改变。

| 负责人 | 独占写入 |
| --- | --- |
| 协调者 | shared/product-profile.ts、shared/provider-settings-ipc.ts、main/index.ts、main/window-state.ts/test、main/session-service.ts的窗口/文件夹边界、gui/package.json、electron-builder.personal.yml、renderer/index.html、根文档和集成验证脚本；appId及userData不变 |
| r2_provider_store | main/provider-settings.ts/test、main/provider-ipc.ts/test、settings-ipc.ts仅Provider注册、preload/channels.ts/index.ts、renderer/ipc/bridge-types.ts/mock-bridge.ts仅Provider桥 |
| r2_provider_ui | renderer/components/Settings/** 与本轮相关测试 |
| r2_workbench | renderer/**，排除Settings/**、ipc/**、index.html；独立显式演示，不写真实会话数据 |

第 1 轮证据和已有产物保持原名与内容，新产物输出release-round-2。协议网络请求不属于本轮。

集成收尾：代理停止后由协调者维护共同集成改动；包括 CLI/package.json 版本一致性、托盘/旧组件品牌测试、网站 demo-bridge 类型补齐及独立真实 Electron 配置/截图验证脚本。旧 Conversation 测试改为直接挂载其实际组件，保留测试覆盖；R2 固定中文页面在语言 guard 中精确列出。最终证据与未完成验收见 reports/round-2.md。

## 第三轮独占范围（2026-10-04）

协调者维护 Provider 公共契约/IPC/桥接、gui main/session-service、桌面入口和产物版本、文档与集成脚本。三实施代理分阶段后再接 UI。

| 负责人 | 独占写入 |
| --- | --- |
| r3_protocols | packages/providers/src/protocols/** 新协议实现与测试；index.ts 根导出由协调者维护 |
| r3_sessions | packages/app-server/src/**，包括唯一授权维护 AppServerConfig.neutralProviders 字段；复用 SessionHost/持久化和工具执行器 |
| r3_store_execution | gui/main/provider-settings.ts/test、provider-ipc.ts/test、新 provider-probes.ts/test、provider-migration.ts/test；packages/tools/src/** 仅本轮执行安全修复/测试 |
| 协调者 | providers/contracts.ts/index.ts、gui/shared 与 preload/renderer IPC、main/session-service.ts、版本/构建、报告/脚本；后续 UI 接线另登记 |

沿用 appId 和 userData、原锁文件，前两轮报告/产物保持不变。真实 API、确定性测试与桌面证据分列。

第三轮后续UI范围：r3_ui独占renderer/components/RoundThreeWorkbench.tsx及测试、App.tsx及相关测试、round-two/round-three.css与必要hooks/store；排除Settings/**、ipc/**。设置发现/验证按钮、语言guard精准例外由协调者维护。r3_store_execution已结束，主进程集成后续由协调者接管；协调者新增tools/round-three-safety.test.ts验证真实中文读写与进程树取消。

## 第四轮独占范围（2026-10-04）

公共 RecoverySummary、bridge 导航确认契约、版本、renderer、根配置、文档和集成验证由协调者唯一维护。锁文件、上游来源和前三轮证据保持不变。

| 负责人 | 独占写入 |
| --- | --- |
| r4_recovery | app-server/neutral-driver、neutral-session、recovery-summary 与相关测试；冻结后由协调者集成 |
| r4_desktop_isolation | gui/main/index、verification-profile、session-service 与相关测试，personal builder 配置及载荷检查；含确认中断导航与测试工作区隔离 |
| r4_core_checks | scripts/round4-fault-service、round4-core-check、launch-round4、round4-cdp；本地 HTTP 故障证据不计外部 API |
| 协调者 | core/types 与导出、gui/preload/renderer/公共契约、版本、文档、最终原生/安装/性能验证与统一审查 |

所有测试均使用显式独立目录，不恢复用户已清空的 HertaAtelier。打包前各实施代理冻结输入。

## 第五轮独占范围（2026-10-04）

| 负责人 | 独占写入 |
| --- | --- |
| r5_messages | 新 MessageContent、message-content 解析辅助及各自测试/样式；不改工作台 |
| r5_titles | app-server/session-host、session-titler、session-topics、session/neutral-session 标题接线与测试；core/session-io/session-title-sidecar 与对应导出/测试 |
| 协调者 | RoundThreeWorkbench 与测试、round-three.css、版本/个人构建、公共契约、文档、集成脚本及桌面验证 |

不改 Provider 契约、上游来源或锁文件；不重跑第四轮完整矩阵，不恢复个人数据。代理完成后冻结源码再打包，最终验证由协调者维护。

## 第六轮独占范围与集成（2026-10-05 冻结）

| 负责人 | 独占写入与冻结后交接 |
| --- | --- |
| r6_permissions | core 权限档位/运行时/引擎、app-server 中立执行与 journal、tools 权限政策及测试；冻结后协调者修全访问和托管路径边界 |
| r6_projects / r6_project_migration | project-navigation 存储与迁移、ProjectSidebar 及测试；后者完成位置重定位、旧后台继承冻结和持久化测试 |
| r6_settings | ProviderSettings 首次流程、settings 和工作台 CSS；公共 Workbench 接线由协调者串行整合 |
| r6_management_finish | workbench-management、session-service 生命周期队列与可信主框架 IPC 检查；冻结后协调者集成 |
| r6_readiness_tests | provider-readiness/errors 的主进程测试和修正、工作台回归、空文件 diff 修复；冻结后协调者集成 |
| 协调者 | shared IPC 唯一维护、main 接线、RoundThreeWorkbench 和显式目录切换、版本/构建、验证脚本、真实桌面/API、文档与交付 |

最终公共契约在 shared/workbench-ipc.ts、provider-settings-ipc.ts；Provider 中立协议与锁文件未更换。R7 只有类型/生命周期契约，没有运行通路。证据按阶段保留，最终来源清单与产物见 reports/round-6.md。没有提交或推送。
