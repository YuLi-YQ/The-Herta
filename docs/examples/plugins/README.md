# 本地执行插件示例

这些UTF-8 JSON包使用schemaVersion 2 / apiVersion 1，示例版本均为1.0.0；内容以导入预览中的源码、差异和hash为准。JSON中的JavaScript不会在导入时自动执行，也不下载依赖。

打开“设置 → 插件 → 执行插件 → 从文件添加”，检查代码并明确勾选能力后确认安装；在“快捷操作 → 运行插件”选择动作。更新源文件不会自动替换已安装版本，需重新导入并确认。

| 示例 | 动作 / 区域 | 所需能力 | 使用条件与行为 |
| --- | --- | --- | --- |
| [快捷便笺](quick-note.herta-plugin.json) | prepare-note；两区 | draft.append | 准备带标题的草稿提案，另点追加才写编辑区，不发送 |
| [文件行数](workspace-lines.herta-plugin.json) | count-lines；工作台 | workspace.readText、draft.append | 读取当前项目内最多64KiB UTF-8文件，统计实际行数/原字节，不修改文件 |
| [文本检查器](text-inspector.herta-plugin.json) | inspect / prepare-draft；两区 | ui.present、ui.update；后续草稿需draft.append | 本地统计，结果按钮只打开可编辑参数，明确运行后才准备草稿 |
| [文件与修改提案](reviewed-files.herta-plugin.json) | create-text-file两区；propose-file-change工作台 | artifacts.create；修改另需workspace.readText/proposePatch | 产物保存至当前会话；修改先冻结差分，用户申请应用后才检查基线并写项目 |
| [公开页面](public-page.herta-plugin.json) | read-page；两区，工作台需可写档位 | network.request仅example.com的GET、ui.present | 显示状态与前6000个Unicode字符；HTML仅文字，受限控制字符替换；不写草稿/文件 |
| [项目命令](project-command.herta-plugin.json) | run-command；工作台可写档位 | commands.run、ui.present | 完全访问也逐条确认；展示真实退出/输出，被批准程序可访问本机资源 |

## 几个容易混淆的地方

- 草稿提案不等于发送；文件修改提案不等于已经应用。产物入口为“快捷操作 → 插件文件”，保存副本由用户选择位置。
- 文件行数：空文本为0行；CRLF、LF和单独CR都是换行；末尾换行不额外算空行。字节数来自实际UTF-8原字节，含原有BOM；不是模型估算。
- 项目命令默认程序git、参数文本["status","--short"]；参数必须是JSON字符串数组。工作目录留空表示项目根，不向SDK传点号。Git是否安装、目标是否为Git项目由用户环境决定。
- 只读/计划模式拒绝工作区修改提案、网络及命令；独立产物和只读统计仍按其能力与区域约束处理。命令自行联网不受network.request来源授权约束。
- 这些例包不调用模型。工坊真实模型生成质量与例包运行是不同结论；内存样本试跑不代表外部项目、命令或网络已经通过。

示例经过分层解析、真实QuickJS和宿主检查，部分还经过实际打包应用专题。网络服务另有显式代理/DoH/HTTPS正向证据，但不能把它混写为所有网络示例/环境都已经端到端通过。

完整格式和额度见[SDK](../../PLUGIN_SDK_V2.md)，操作边界见[文件](../../PLUGIN_FILES_V1.md)、[命令](../../PLUGIN_COMMANDS_V1.md)、[联网](../../PLUGIN_NETWORK_V1.md)和[受控视图](../../PLUGIN_UI_V1.md)。
