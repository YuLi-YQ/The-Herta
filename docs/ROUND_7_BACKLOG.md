# 第七轮已确认待办：结构化补充信息

状态：2026-10-05 已实际实现并随0.7.0安装交付；见reports/round-7.md。原生工具角色已打通真实问答，0.7.1已补充未提交表单草稿恢复，0.7.2已实现纯文本提问回退并通过模拟协议测试，真实供应商专项仍待验证。以下保留原验收需求，不能将其中未来时措辞解读为当前未施工。

## 需求

当黑塔/执行器需要用户补充信息，提供会话内持久问题卡：单选、多选、自由文本及混合题；必要时弹出对话框，但不能丢失到历史之外。选项可附简短说明，支持自由补充；默认高亮不等于提交，用户明确提交才继续。

## 协议与生命周期

第六轮冻结的类型位于 packages/gui/src/shared/workbench-ipc.ts：PendingUserInput 和 UserInputAnswer，schemaVersion 为 1。请求含 requestId/sessionId/turnId、waiting_for_input/answered/cancelled 状态、questions；题含 id/prompt/kind(single/multiple/text)/required/allowText/options，选项含 id/label/可选 description。答案含相同归属 ID、action(answer/cancel/skip/defer)、answers(questionId/optionIds/可选 text)。第六轮没有请求工具、回答 IPC 或虚拟继续执行。

第七轮实现必须按以下冻结规则校验：每请求 1–8 题、每选择题 1–12 选项；ID 1–128 字符、题干 1–2000、选项 label 1–300、description 最多 1000、每题自由答案最多 8000 字符，总有效载荷最多 64 KiB。ID 在各自范围唯一，拒绝未知字段/选项/重复答案；单选最多一个选项，多选只接受该题选项，text 题 options/optionIds 为空。必填题 answer 必须有符合题型的非空内容；非 allowText 选择题不接受自由文字。运行校验尚待第七轮实现，不能把类型当成已有保护。

主进程核对实际活动/挂起会话、turn 和当前 pending 请求，拒绝其他来源/旧 ID/重复提交；明确 waiting_for_input 状态，与权限审批分开。回答以中立结构化工具结果回发原执行流程，不拼 shell 命令。

取消、稍后回答、显式跳过（仅非必填）分别表示，不把取消当空答案或同意。切会话保留卡片，重启能重建待回答状态，不自动重复工具；旧请求、重复提交和其他会话回答均不能继续当前任务。与权限档位无关，即使完全访问也必须等待真正需要的人类决定，不能替用户选择。

defer 保留 waiting_for_input，不能交付虚拟答案；cancel 结束该请求且不继续原工具；skip 仅在全部未回答题非必填时允许，明确记录跳过；answer 仅一次落盘后继续。journal 保存问题和最终动作，重启由 durable pending 重建；写答案失败不得继续，继续失败不得重复执行已经完成的工具。默认高亮始终不等于提交。

## 完成条件

实际模型提出问题→渲染选项+文本→用户提交→原任务使用答案继续，三个协议通过同一中立工具结果通路。针对性覆盖单/多选、自由文本、中文IME、无答案、取消、重复/过期ID、会话切换和重启；至少一条授权服务端到端，其余协议按改动范围验证，不伪造全矩阵通过。

新模块不能触发额外文件审批或把表单答案直接拼成shell命令。继续使用TEST_ACCESS的隔离测试配置。未来用户反馈如需调整轮次，保留需求而非悄悄延期删除。
