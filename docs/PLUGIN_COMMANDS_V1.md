# 插件项目命令

commands.run 只供工作台执行插件使用。安装授权不能替代每次具体命令的确认，完全访问模式也不跳过。此接口使用本机当前用户进程，不是操作系统级文件或网络隔离。

## 使用与逐条确认

`commands.run` 仅供工作台动作使用；安装时勾选能力后，每次具体命令仍须用户确认，完全访问也不跳过。

| 当前状态 | 行为 |
| --- | --- |
| 与黑塔聊天 | 拒绝命令能力 |
| 工作台只读或计划模式 | 拒绝命令能力 |
| 工作区编辑、完全访问 | 使用真实 Session 的独占工作区操作门，每条命令单独确认 |
| 会话忙、项目或权限变化、停止运行 | 不开始新的执行，已开始的执行进入取消处理 |

审批展示原始程序与各个参数、项目内工作目录、时限及风险说明。先看到完整 argv，再决定本次允许或拒绝；安装授权、常规命令缓存及其他轮次的批准不能替代这次确认。灾难性命令及入口保护规则拒绝的请求不能靠批准放行。

普通测试、构建和项目工具可使用本接口，例如 `git status --short`、`npm run build` 或 `python scripts/check.py`，不是只读命令白名单。它不创建模型轮次，也不把命令结果自动附加给模型、写入草稿或发送消息。

## SDK

```js
const result = await api.commands.run({
  argv: ['git', 'status', '--short'],
  timeoutMs: 15000
});
return { exitCode: result.exitCode, stdout: result.stdout };
```

参数仅为 `{ argv, cwd?, timeoutMs? }`：

- argv 为 1–64 项字符串数组，每项最多 2048 个 UTF-16 单位；第一项是程序名，其余各项分别是参数。整个能力参数仍受 64 KiB JSON 预算限制，控制字符与非法编码拒绝。
- cwd 省略时使用当前项目根。指定时必须是项目内相对目录，如 `packages/gui`；不得传 `.`、空字符串、绝对路径、父目录跳转或受保护目录。宿主在实际执行前检查物理根目录、目录身份及读取路径。
- timeoutMs 默认为 15000，范围 1–60000，单位毫秒。能力调用包括确认等待在内总计最多 60 秒；确认耗时会减少实际可用时间，设置 60000 不保证获批后仍有完整 60 秒。
- 不接受 env、background、shell、持久日志位置或会话标识。Guest 不得到 Node 对象、通用 ToolContext 或进程句柄。

返回值为 `{ exitCode, signal, timedOut, durationMs, stdout, stderr, stdoutBytes, stderrBytes, stdoutTruncated, stderrTruncated }`。非零退出码仍返回真实结果，不伪装为成功；超时尽可能保留已捕获的部分输出。停止、失效、拒绝及启动失败使用固定错误码，不把宿主异常堆栈或个人路径作为错误详情交回。

每路输出最多捕获 64 KiB，返回正文每路最多约 24 KiB，超过后附截断标记；原始字节计数与截断状态分别保留。普通程序按 UTF-8 解码；Windows `cmd /u` 按 UTF-16LE，传统 cmd/PowerShell 则按固定宿主探针取得的控制台页选择 GB18030（936/54936）或 UTF-8。探针使用相同净化环境，最多 2 秒，并计入本次执行时限且可取消；没有给 Guest 增加编码或探针参数。自行改变输出编码的程序仍可能不符合这些默认规则。输出另做已知秘密格式脱敏与控制字符清理；脱敏不是识别所有秘密的保证，不应要求程序打印凭据。此接口不保存 `.herta/logs`，也不返回后台 ID 或其他会话日志位置。

## 本机执行边界

这是用户明确确认的本机进程执行，不是操作系统级文件或网络隔离。cwd 和可见参数的保护检查约束执行入口；被批准的程序、项目脚本及其依赖仍以当前用户的系统访问能力运行，可能自行读取项目外文件、修改文件、联网或启动其他程序。安装 `commands.run` 不表示这些程序被严格限制在项目目录内。

尤其是命令内自行建立的网络连接，不经过 `api.network.request` 的 HTTPS 来源、方法及公网地址限制。`network.request` 的来源授权只约束该 SDK 接口，不能视为本机命令的网络防火墙。请按确认卡中的实际程序和参数判断本次执行。

宿主从零建立精简环境，不自动继承个人 Key、代理、loader 注入或个人配置定位变量；HOME、USERPROFILE、APPDATA、TEMP 等指向独立临时目录，结束后按目录归属核验清理。可信 PATH 排除空项、相对项、当前项目和应用保护目录。清理或配置重定向不能阻止已批准程序主动查找系统中的其他文件。

宿主正常以 argv 执行，不隐式解释管道、重定向或变量。Windows 的 npm、pnpm、npx、yarn、corepack 如通过可信 PATH 找到 `.cmd/.bat`，仅由宿主使用固定、已检查参数的 shim 包装，关闭 cmd AutoRun；含不安全 cmd 元字符的参数拒绝。这不是 Guest 可设置的 shell 开关。用户显式请求 shell 程序时，仍需对其完整原始 argv 逐条确认。

取消和超时复用既有进程树终止机制，等待执行收敛再释放工作区操作。它不提供 Windows Job Object 级别的所有后代回收保证；程序自行脱离的后代可能继续存在。停止不能撤销已写入的文件、已发送的网络请求或已经完成的系统调用，失败后不自动重放。路径检查和启动之间也不是操作系统原子事务。

## 正式示例

[project-command.herta-plugin.json](examples/plugins/project-command.herta-plugin.json) 声明 `commands.run` 和 `ui.present`，只有工作台动作 `run-command`，导出函数 `runProjectCommand`。

默认程序为 `git`，参数文本为 `["status","--short"]`，工作目录留空，时限 15000 毫秒。参数文本必须能解析为 JSON 字符串数组；例如将程序改为 `npm`、参数改为 `["run","build"]` 可请求项目构建。留空的工作目录由例包省略，不向 SDK 传 `.`。

例包先等待本次命令确认及实际结果，再用受控卡显示退出码、耗时、超时、信号、原始字节数、宿主截断与结果卡截断状态。stdout、stderr 每路再取前 4000 个 Unicode 字符，控制字符替换为 �，作为纯文本显示；不自动发送消息或写入草稿。命令本身的作用由被批准的程序决定。

实现入口：[窄命令适配器](../packages/tools/src/plugin-command.ts)、[运行控制器](../packages/gui/src/main/plugins/executable-plugin-controller.ts)、[Session 权限门](../packages/app-server/src/workspace-operation.ts)。
