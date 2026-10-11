# 第 1 轮桌面与个人打包基线

日期：2026-10-03。固定上游：PersonaCLI/Herta `8fb809934e0807ee0f0f590d87365a83bb720ca2`。本页记录实际代码与针对性检查；真实窗口、安装器和完整集成验收以 [本轮报告](reports/round-1.md) 为准。单元测试不代替真实桌面或真实 API。

## 实际改动

- `packages/gui/src/shared/product-profile.ts` 由协调者唯一维护，工作名称为 **Herta Atelier**，`appId` 为 `personal.herta.atelier`，语音、3D 与自动更新均为 `false`。
- `main/index.ts` 在单实例锁、Chromium session 和本地设置初始化前设置名称、AppUserModelID 与数据路径。先创建目录，再设置 `userData` 和 `sessionData` 到 `%APPDATA%\HertaAtelier`；不会沿用 `%APPDATA%\Herta`。启动日志 `[atelier] desktop profile` 输出实际两条数据路径和禁用能力，无密钥。
- 首次设置默认中文、深色、关闭窗口退出。已存的语言、主题与关闭策略保留，单实例锁、窗口状态保存、退出等待会话落盘与受限 preload 继续沿用上游。
- 个人入口绑定 `createDisabledUpdateService()`；不导入或实例化 `electron-updater`，不读取 `HERTA_UPDATE_URL` 或上游更新通道。手动检查、立即安装与开启自动更新的 IPC 均明确拒绝。上游通用更新服务保留用于溯源，它不是本项目实际运行链路。
- 语音与 3D 的 privileged scheme 和协议均按产品配置关闭。`settings-ipc.ts` 在主进程拒绝全部语音启用、模型下载/取消/删除、云端克隆、语音引擎和 MiniMax 密钥写入入口；读取只返回禁用/缺席状态，不触及下载管理器或语音服务。协调者/会话代理同步给 `session-service.ts` 的语音初始化和构建时 worker 插件加能力门槛。
- `session-activation.ts` 打开会话时只恢复历史，已移除自动 `regenerateLastReplyIfOrphaned()`。页面重载同样只同步会话；避免崩溃或重启后自动再次调度有副作用的工具。显式“继续”仍是用户主动发起的路径，完整恢复与审批流程留在 R3/R4 实测。
- 托盘 tooltip 和原生窗口标题使用 Herta Atelier。图标为本项目抽象几何，占位来源与保留的上游素材见 [台账](../assets/ASSET_MANIFEST.md) 和 [素材审计](ASSET_AUDIT.md)。没有调用图像生成，也没有网络发布。

## 个人打包模式

新增独立配置 `packages/gui/electron-builder.personal.yml`。它提供 Windows x64 的 NSIS 安装器与 portable exe，输出到 `packages/gui/release-personal`，独立名称、快捷方式与安装标识，不携带发布 feed，不自动删除用户数据。上游 `electron-builder.yml` 留作基线对照；本项目默认分发命令接到个人配置。

个人配置不包含 voice、voice-clone、tts-runtime、3D scene、保留的 upstream-assets 或任何生产 `node_modules`。包含根 `LICENSE`、`THIRD-PARTY-NOTICES.md`、素材台账、素材审计和原创几何许可；Electron/Chromium 许可由 electron-builder 随运行时放入包。

正常 Node 22.23.3 / pnpm 9.15.0 环境中，使用协调者接线的命令：

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm build:gui
# 仅当实际 bundle 变化后更新告知，再保留 --check 门槛
pnpm --filter @herta/gui notices
pnpm --filter @herta/gui dist
```

`dist` 的个人等价命令（在 `packages/gui` 下）为：

```powershell
electron-vite build
node scripts/third-party-notices.mjs --check
node scripts/check-personal-payload.mjs
electron-builder --config electron-builder.personal.yml --win --x64 --publish never
node scripts/check-personal-payload.mjs --unpacked release-personal/win-unpacked
```

`check-personal-payload.mjs` 核验编译入口、许可证文件、个人标识和无更新 feed；拒绝语音/TTS/3D 文件、已知未批准资源名、原素材 SHA-256、配置/会话文件。`--unpacked` 另外检查真正生成的 exe、随包许可、`app.asar` 所有文件和资源目录。该校验是包内容证据，不能自行宣布窗口、安装流程或 API 通过。

## 已运行的针对性检查

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| 禁用语音与自动更新的主进程 IPC、恢复不自动重放、禁用更新器 | 3 个文件、23 个单元测试通过；确定性依赖替身，不是桌面/API 实测 | [desktop-unit.log](reports/evidence/round-1/desktop-unit.log) |
| 上游通用更新器回归 | 原有 16 个单元测试通过 | [desktop-unit.log](reports/evidence/round-1/desktop-unit.log) |
| GUI 主进程 TypeScript | 针对检查无诊断；随后增加首次路径创建，最终版本由集成检查覆盖 | [desktop-check.log](reports/evidence/round-1/desktop-check.log) |
| 归属代码/脚本 Biome | 初次发现 6 项格式/导入排序错误，已修复，复核退出码 0 | [desktop-check.log](reports/evidence/round-1/desktop-check.log) |

## 真实桌面回归入口

在真正运行的 Electron 页面内，从既有受限 `window.herta` 调用；不得通过伪造 bridge 响应替代：

| 真实 bridge 方法 | 个人版本预期 |
| --- | --- |
| `getUpdateState()` | `{ phase: "idle", unsupported: true }` |
| `checkForUpdate()` / `restartAndInstall()` | Promise 拒绝，错误包含“禁用自动更新”；不退出、不安装、不请求 feed |
| `getAutoUpdate()` / `setAutoUpdate(true)` | 读取 `false`；开启请求拒绝 |
| `getRealtimeVoice()` | `enabled/bundle/runtime/failed` 为 `false`，`model.phase` 为 `absent`、体积为 0 |
| `setRealtimeVoice(true)` / `setVoiceEngine("minimax")` | 拒绝，错误包含“不提供语音” |
| `downloadVoiceModel()` / `prepareMiniMaxVoice()` | 拒绝，不下载、不启动 worker、不创建克隆 |
| `getMiniMaxKeyStatus()` / `getMiniMaxPlanKeyStatus()` | 无 Key 状态，不读写语音密钥 |

安装包真实启动、关闭重开、安装/卸载与无凭据界面启动由协调者在本轮报告中逐项记录。三个 Provider 协议、实际工具闭环、跨协议历史转换、停止/子进程树与审批属于后续轮次；本轮没有依据把它们标记为通过。实际服务凭据缺失时应写阻塞，不能用此次单元测试替代。

## 文件所有权与剩余范围

本代理修改：`main/index.ts`、`main/update-service.ts`、`main/settings-ipc.ts` 与测试、`main/tray.ts`、`main/session-activation.ts` 与测试、新增 `main/update-disabled.test.ts`、个人打包配置与校验脚本、本文及两份获授权的证据日志。没有修改锁文件、package.json、preload 或公共契约。

新 Provider 的配置、能力、适配器契约由协调者冻结，实际 OpenAI Responses / Chat Completions / Anthropic Messages 链路仍需 R3 实施。旧 DeepSeek 绑定仅用于上游现状核查，不能把本轮静态设置或占位表单称作多 Provider 实现。
