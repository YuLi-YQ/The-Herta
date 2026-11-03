# The Herta 开发约定

适用于本仓库的开发代理与贡献者。用户当前要求、运行环境权限与审批规则优先。

## 项目与范围

- Windows 桌面应用，Electron、React、TypeScript。工作台与独立聊天各自保存状态；聊天不能隐式读取或执行工作区操作。
- 先阅读 README、相关模块和现有测试，再做小范围修改。不要把参考网站、未启用语音或旧角色素材当成当前交付内容。
- 保留深浅主题、键盘操作、动效关闭与系统 reduced-motion。错误必须如实表达，角色文案不改变权限或成功状态。
- 不顺手升级依赖、改版本、应用身份或资料目录；确有需要时说明兼容性和迁移方案。

## 构建与检查

使用 Node 22.23.3 和 pnpm 9.15.0，按 lockfile 安装。Windows 可运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/bootstrap-windows.ps1
./scripts/pnpm.ps1 build
./scripts/pnpm.ps1 --filter @herta/gui typecheck
./scripts/pnpm.ps1 exec vitest run <相关测试文件>
./scripts/pnpm.ps1 dist:personal
```

这些命令分别执行；pnpm.ps1 会退出所在脚本进程。GUI 依赖共享包的 dist，打包前必须先 build。公开默认 builder 与 dist:personal 都只生成 Windows 包，不自动发布。CI 的定向检查不代表所有平台、模型或真实业务已经验收。

- 修改后按风险选择现有定向测试和类型检查；已通过且未受影响的验证不反复运行。
- 测试用独立临时工作区和 profile，不读取个人会话、附件、记忆或凭据。真实 API 验证必须有明确授权，最少调用，不记录 Key、headers 或私人内容。
- 区分单元测试、开发页面、实际 Electron、真实服务和用户验收；不能用某一层的通过替代其他层。

## 实现与数据边界

- 主进程验证 IPC，外部文本、文件、插件包和模型返回均作为数据处理，不能自行授予权限。
- 保留失败草稿、防止重复发送与工具重放；异步结果绑定会话、请求和配置版本，不覆盖后续编辑。
- 存储兼容旧数据，明确处理损坏与保存失败；不能静默清空。修改存储或覆盖安装前说明备份和恢复方式。
- 搜索优先使用 rg。Windows 文件操作使用明确路径；递归移动或删除前确认范围，不跨 shell 拼接破坏性命令。
- 不重置、清理或覆盖其他人的未提交工作，不把未跟踪文件当作垃圾。

## 提交与发布

- 提交说明写清用户可见变化、验证范围和限制。只加入明确审查的文件，不盲目 git add .。
- 不提交依赖、运行时、安装器、测试 profile、凭据、私人日志、截图或本地资料备份。
- 源码构建成功不等于已经安装或发布。CI 不创建标签或 Release；发布由维护者另行审阅产物、许可证、目标提交与哈希。
- 保留 LICENSE 和 THIRD-PARTY-NOTICES；代码许可不自动覆盖角色、美术、字体、对白或声音。新素材先确认授权与用途。
