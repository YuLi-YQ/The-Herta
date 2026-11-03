# 本地 JavaScript 插件开发说明

适用于当前 0.8.10 源码的本地 JavaScript 插件接口。提示词插件继续使用独立的 schemaVersion 1；执行插件使用 schemaVersion 2 / apiVersion 1。下载版本支持哪些功能，以对应 Release 说明为准。

使用入口见[插件工坊](PLUGIN_WORKSHOP.md)，可导入文件见[示例目录](examples/plugins/README.md)。安装声明只是请求，实际能力仍取动作声明、用户授权和当前宿主权限的交集。

## 安装和使用示例

这里提供六个本地 JSON 示例包；每个包标明所需版本和实际能力。逐动作ID、历史执行证据与仍需环境条件见[样例目录说明](examples/plugins/README.md)。只修正公开页面的C1显示字符处理，其余五包与对应历史样本字节一致，未因新轮次重跑。

| 示例 | 适用位置 | 需要勾选的能力 | 实际行为 |
| --- | --- | --- | --- |
| [快捷便笺](examples/plugins/quick-note.herta-plugin.json) | 工作台、与黑塔聊天 | 准备聊天草稿（draft.append） | 保留输入正文，准备带“便笺”标题的草稿提案；不读取文件，不调用模型 |
| [文件行数](examples/plugins/workspace-lines.herta-plugin.json) | 工作台 | 读取当前项目文件、准备聊天草稿 | 读取一个最多 64 KiB 的 UTF-8 文本文件，统计实际行数/原始字节数，准备统计草稿；不修改文件，不调用模型 |
| [文本检查器](examples/plugins/text-inspector.herta-plugin.json) | 工作台、与黑塔聊天 | 创建/更新结果视图；如需后续草稿，再授予 draft.append | 本地统计输入文本，展示字段、代码预览、说明和状态；结果按钮只预填可编辑参数，用户再次运行后才准备草稿 |
| [文件与修改提案](examples/plugins/reviewed-files.herta-plugin.json) | 文件生成适用于两区；提案仅工作台可写档位 | artifacts.create；提出修改另需 workspace.readText/proposePatch | 保存精确文本产物；或读取原文件哈希并生成冻结提案，用户在独立文件面板检查后明确申请应用 |
| [公开页面](examples/plugins/public-page.herta-plugin.json) | 两区；工作台需可写档位且遵守联网确认 | example.com的GET、ui.present | 只读取固定来源并显示HTTP状态和前6000字符纯文本，不写草稿、不生成文件、不调用模型 |
| [项目命令](examples/plugins/project-command.herta-plugin.json) | 仅工作台可写档位，完全访问也逐次确认 | commands.run、ui.present | 确认后执行真实本机命令并展示结果；被批准程序能访问本机文件/网络，不是OS隔离 |

例包内容更新后，须重新导入、审阅差异并确认；旧安装不会自动替换：

1. 打开 **设置 → 插件 → 执行插件 → 从文件添加**，选择其中一个 `.herta-plugin.json` 文件。
2. 查看名称、版本、操作及 **查看插件代码**，勾选本次允许的能力，然后选择 **确认安装插件**。没有勾选的能力不会默认开放。
3. 打开一个空闲会话。输入框旁的 **快捷操作 → 运行插件** 中选择操作，填写参数，点击 **开始运行**。文件行数需要工作台已经选定项目，参数填写项目内相对路径，如 `README.md`。
4. 查看运行结果及草稿提案；需要使用时点击 **追加到草稿**。这一步才把文本追加到编辑区，不自动发送，也不替换原有草稿。

运行“检查文本”后可以直接阅读统计卡；点击“整理为草稿”只会切换到参数表单，检查或修改正文后再点“开始运行”。若未授权 draft.append，原统计动作仍可使用，但后续草稿动作不能启动。成功准备提案后还需点击“追加到草稿”，不会自动发送。

文件样例的结果在 **快捷操作 → 插件文件** 查看，关闭运行菜单或重启后仍保留。生成文件可“保存副本”，只读工作台也可生成独立产物；创建工作区修改提案和申请应用均要求可写档位。提案只是冻结内容，点击“申请应用”后才再次核对当前权限和原文基线并真正写入。普通创建/编辑在工作区编辑和完全访问档位沿用既有覆盖策略，不再弹一次重复确认；只读/计划模式拒绝。样例的新建开关字段为小写 `new_file`，只用于目标不存在的情况。详见[插件文件说明](PLUGIN_FILES_V1.md)。

切换会话、编辑原草稿、停用/更新插件或改变相关权限后，旧结果不能直接写进新的编辑区；重新运行并确认即可。失败或停止的运行不提供可直接加入的草稿提案。此流程是当前代码行为说明，不是原生 UI/DPI/IME 的验收通过声明。

安装预览保存的是已经读到的冻结内容，10 分钟有效。导入后再修改原始文件，不会改变正在确认的预览；要安装新内容，请重新导入。安装、更新、调整权限与回退都需要明确确认；更新和回退不会悄悄沿用旧授权选择。

## 一个包包含什么

包只有 `manifest` 和 `files` 两部分，内容是 UTF-8 JSON。扩展名 `.herta-plugin.json` 方便识别；当前只支持本地 JSON 导入，不支持 ZIP、目录包、远程市场或自动下载依赖。

- manifest 固定 `schemaVersion: 2`、`apiVersion: 1`，并声明 ID、名称、三段数字版本、说明、入口、能力和动作。
- files 是 `{ path, source }` 数组；source 是普通 JS/ES module 的源码字符串。可以先在编辑器里编写 JS，再用 JSON 序列化工具写入 source，避免手工漏转义换行或引号。
- 每个动作声明 `id/title/scope/export/inputs/capabilities`。动作的能力必须来自 manifest；manifest 声明的能力至少由一个动作使用。
- scope 是 `chat/workbench/both`。工作区读取只允许 workbench 动作；聊天不会因为应用中开了项目就获得项目权限。
- 输入支持有长度限制的 text、固定选项 select、有范围的 number 和 boolean。真实输入在运行前再次校验，未知字段、错误类型和缺少必填项会被拒绝。

JS 导出函数由 export 字段选择，例如示例中的 `run`：

```js
export async function run(input, api) {
  await api.draft.append({ text: input.text });
  return { summary: '草稿提案已准备，等待用户确认。' };
}
```

返回值必须能表示为有界 JSON。字符串、有限数字、布尔、null、数组和普通数据对象都可以；不要返回 undefined、BigInt、循环对象、函数或原生资源。

所有文件路径必须是包内可移植的相对 `.js`/`.mjs` 路径。静态和动态 import 只能引用包内模块，例如 `./helpers.js`；不接受 node:、URL、绝对路径、盘符或越出包根目录，也不隐式读取 node_modules。插件中没有 Node、DOM、fetch、Electron 通用 IPC 或定时器 API。纯 JS 库可以事先打包进文件表，但安装时不会替你运行 npm 或任意构建脚本。

## 当前源码的十二种能力

调用形式统一为一个数据对象，返回 Promise。只有动作已声明、用户已授予且当前宿主支持的能力才能执行。

| SDK | 参数 | 返回值及边界 |
| --- | --- | --- |
| `api.workspace.readText` | `{ path, maxBytes? }` | `{ text, bytes, sha256 }`；仅工作台当前项目内允许的 UTF-8 文本，默认64 KiB、最高128 KiB；增加原始字节SHA-256，bytes/hash含BOM，即使text已去BOM |
| `api.workspace.proposePatch` | `{ path, baseHash, content }` | `{ proposalId, path, baseHash, nextHash, additions, deletions, status: 'pending' }`；仅保存工作台修改提案及真实差分，不直接写项目 |
| `api.artifacts.create` | `{ name, mime, text }` | `{ artifactId, name, mime, bytes, sha256, saved: true }`；保存至当前会话文件库，不自动附加、另存或发送 |
| `api.network.request` | `{ url, method, body? }` | `{ status, ok, contentType, body }`；受限HTTPS公网文本，来源/方法安装授权、工作台当前权限确认，详见[联网协议](PLUGIN_NETWORK_V1.md) |
| `api.commands.run` | `{ argv, cwd?, timeoutMs? }` | 真实exitCode/signal/timedOut/durationMs及有界stdout/stderr和字节/截断状态；仅工作台，每条确认，详见[命令协议](PLUGIN_COMMANDS_V1.md) |
| `api.storage.get` | `{ key }` | 此插件先前保存的 JSON 值；不存在时为 null |
| `api.storage.set` | `{ key, value }` | null；写入插件自己的资料，不是项目文件或用户聊天记忆 |
| `api.draft.append` | `{ text }` | `{ staged: true }`；只累加本次运行的草稿提案，用户点击后才追加至编辑区 |
| `api.log` | `{ level, message }` | null；level 为 info/warn/error，message 最多 2000 单位；展示为处理记录 |
| `api.progress` | `{ message, value? }` | null；message 最多 500 单位，value 可为 0–1 的有限数字 |
| `api.ui.present` | `{ view: { title, blocks, actions } }` | `{ viewId, revision }`；每次运行至多创建一个受控视图，初始 revision 为 1 |
| `api.ui.update` | `{ viewId, revision, view }` | `{ viewId, revision }`；整份替换同一次运行的视图，只接受当前版本，成功后版本加一 |

key 最多 80 个受限 ASCII 字符。draft.append 单次及累计提案最多 32000 个 UTF-16 单位；参数总字节上限仍适用。日志最多保留本次的 64 条。读取文件时还会检查当前权限、受保护路径、实际项目根目录、链接与文件是否在读取期间发生变化；完全访问档位也不把此接口变成任意读取电脑文件。

文件原始字节上限与返回 JSON 的 256 KiB 上限分别检查。某些文本经过 JSON 转义会变大，所以即使原文件未超过 128 KiB，也可能因返回预算而失败；应按需要降低 maxBytes，不能把失败当作空内容。

十二项声明能力均已接宿主。commands.run 每条确认后使用本机执行：完全访问也确认，聊天/readonly/plan拒绝；默认15秒/最高60秒，确认与执行共享broker60秒预算，cwd省略表示项目根。Guest本身仍隔离，但被批准程序可以按当前用户权限访问本机文件/网络。详见[命令边界](PLUGIN_COMMANDS_V1.md)。

### 受限联网

声明仍须附HTTPS origins和methods。安装明确勾选后，聊天显式Run即可请求；工作台readonly/plan连GET也拒绝，workspace-edit逐次确认完整URL/方法/正文大小，full-access沿既有覆盖。参数仍只有 `{url,method,body?}`，Guest不能指定代理、解析器、header、Cookie、Key或TLS选项。

用户可以在插件设置明确选择数字IP HTTP(S) CONNECT代理及可信DoH/公网引导IP。宿主固定已验证的公网目标IP，并按原目标及解析服务主机名验证TLS；HTTPS代理证书须覆盖其数字IP。无PAC/SOCKS/认证或自动直连、DNS回退，不改系统/Provider配置。损坏配置暂停联网；这些设置不改变每条commands.run确认。

文本响应最多64KiB；网络15秒共同包含DNS/DoH、CONNECT、TLS和响应，确认与请求合计仍受broker60秒限制。配置版本变化停止在途请求；取消不能撤销已送往远端的操作。详见[完整协议与配置步骤](PLUGIN_NETWORK_V1.md)。不同下载批次的支持范围以 Release 说明为准。

### 持久文件与工作区提案

artifacts.create只接受text/plain、text/markdown、text/csv、application/json，按原样UTF-8保存。产物独立于运行成功与否；插件停用后仍属于原会话，可读取/另存。保存对话框返回后再次校验当前归属，选择路径不会使插件获得任意文件权限。

proposePatch的content是修改后的完整文本。现有文件使用readText返回的sha256，新建使用null基线且要求目标不存在；已有BOM会保留，nextHash按真实新字节计算。创建只得到pending。用户检查差分并申请应用后，通过真实Session的工作区操作门复核来源插件启用状态、内容哈希/授权修订、owner、计划锁、当前权限、路径和原文基线；不伪造模型轮次记录。

写前保存意图，提交后保留真实凭据；完成元数据保存失败不能说文件未写入。未终结意图及无法确认的结果进入needs-review，不自动重放；损坏原件保留。关闭菜单和Guest后续失败不清除已经保存的产物或提案。完整状态、配额和外部文件竞争限制见[文件契约](PLUGIN_FILES_V1.md)。

### 受控视图与后续动作

视图是 `{ title, blocks, actions }` 纯数据，包含 text、code、list、table、status、fields 六种内容块。总 JSON 最多 48 KiB UTF-8，最多 24 个块、8 个按钮；详细逐项限制见 [视图协议](PLUGIN_UI_V1.md)。代码、HTML 或 URL 字样作为文字交给宿主展示，不会获得 HTML、样式或任意组件注入能力。

按钮只声明同一插件中的动作及 `inputJson` 对象文本。宿主按实际动作的区域、必填参数、默认值和类型检查；按钮不授予能力，也不自动运行。参数表单沿用 manifest 定义，不另设一套可执行的表单语言。

同次运行更新必须携带当前 viewId/revision；旧版本和其他运行的句柄被拒绝。后续动作只在原运行成功结束后可用。开始前会重新核对插件内容、会话、授权与草稿修订，并在异步读取完成后再核对一次。失败、停止、跨会话或授权变化使旧视图失效，不能凭旧按钮继续操作。

后续动作成功被运行服务接受后，原结果视图被消费，防止双击或重复提交。参数错误、权限不足、进程创建失败或同步发送失败会保留原结果，允许修正。已接受启动后发生异步启动超时或运行失败，仍不会恢复旧按钮自动重试，避免重放可能已经开始的操作。视图本身不作为永久聊天内容保存。

### 必须等待能力调用完成

每次 SDK 调用都要 await，包括日志和进度。不要使用 fire-and-forget：动作返回时如果还有请求未结束，整次运行会被记为 guest-error，相关在途请求会被取消。

```js
await api.log({ level: 'info', message: '开始统计。' });
const file = await api.workspace.readText({ path: input.path });
await api.progress({ message: '读取完成。', value: 1 });
await api.draft.append({ text: file.text.slice(0, 200) });
return { summary: '已准备片段。' };
```

上面的片段需要在 manifest 和对应动作中声明四项能力。不要让 return 先于 Promise 完成，也不要把声明能力当成已经获得用户授权。

宿主拒绝会以固定错误码拒绝 Promise，不附带原始宿主堆栈或私密路径。可以做有限的可恢复处理，不能用重试绕过拒绝：

```js
try {
  const value = await api.storage.get({ key: 'last-note' });
  return { value };
} catch (code) {
  if (code === 'capability-denied') return { summary: '未开放插件资料读取权限。' };
  throw code;
}
```

常见运行结果：invalid-input 表示参数不符合定义；missing-export 表示入口缺少指定函数；module-denied 表示引用了不允许的模块；resource-limit/timeout 表示超出限额；revoked 表示插件、授权或会话已经变化；cancelled 表示已停止。捕获错误不能恢复已撤销的运行，也不能使未完成的操作被当作成功。私有资料损坏等宿主错误保持失败，不用空对象替代。

## 包格式与运行限额

| 项目 | 上限 |
| --- | --- |
| 完整 UTF-8 JSON 包 / manifest | 2 MiB / 128 KiB |
| 模块 | 最多32个，每个256 KiB，全部源码合计1 MiB；路径最多160个单位 |
| 动作 / 单动作输入 | 最多24个 / 16个；text输入的maxLength最高16000 |
| 动作输入 / 一次能力参数 / 输出JSON | 32 KiB / 64 KiB / 256 KiB |
| 运行 | 固定64 MiB WASM线性内存，CPU预算1秒、连续忙碌看门狗2秒、总时限5分钟 |
| 能力调用 | 每运行64次、最多8个在途；待处理JS作业4096；能力等待最多60秒 |

大小上限同时生效。字符串长度按UTF-16单位计，JSON预算按UTF-8字节计；转义后可能更大。64 MiB不是整个进程RSS限制。固定QuickJS 0.32.0在独立解释器中执行，可信Worker和外层utilityProcess负责中止与故障收口；普通Node Worker本身不被当作安全隔离。

格式拒绝未知字段/版本/能力、重复键/标识、非法编码、危险对象键、路径越界和Windows不可移植名称。包解析只接收JSON文本，不执行getter、toJSON或安装脚本；模块只能从经过验证的包内文件表加载。具体规则见[契约解析器](../packages/gui/src/shared/executable-plugins.ts)与[运行协议](../packages/gui/src/shared/plugin-runtime.ts)。

## 存储、恢复与更新

安装包、插件私有资料、生成文件、工作区提案及制作草稿共用512 MiB逻辑字节预算；各库的小额度继续生效，临时文件/备份/损坏记录也计入。未知占用不能当作0，旧资料超额不因此删除，新增写入会被拒绝。

插件私有资料每插件256 KiB、键最多100项。损坏时不会返回空对象伪装正常；设置提供预览后恢复有效备份或保留原件再重建。安装库也有明确恢复/重建，保留当前版及三个历史版本。卸载不删除用户原始导入文件。

清理仅包含安装库可确认的无引用包、精确临时文件及明确选择的旧归档。制作草稿另有自己的预览/确认删除；生成文件、修改提案和私有资料不被当作缓存自动清掉。详见[存储维护](PLUGIN_STORAGE_MAINTENANCE.md)。

## 验证边界

六个示例有解析器、实际QuickJS及分层宿主执行检查；部分还有实际打包应用的专题检查。已在单个DeepSeek Flash服务上验证真实识图、摘要和一个真实生成包，生成包未手修后完成本地试跑、明确测试安装和运行。网络服务另有显式代理/DoH/公开HTTPS正向记录。这不保证所有模型、代理或原生业务组合都通过。

工坊试跑始终使用内存样本；真实生成、模拟试跑、安装后执行和用户检查是不同结论。远程市场、任意UI注入、无人确认改应用核心和TTS不在这些能力中。
