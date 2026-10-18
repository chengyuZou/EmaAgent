# Turn

[English](./README.md)

本包负责 Session 输入排队与单次 Turn 执行. `SessionContinuationQueue` 决定何时交付输入, `TurnExecutor` 准备模型和工具, 保存消息, 驱动 AgentLoop, 最后清理执行并释放 Session.

## 启动与结束

Server 创建队列, 执行器和共享的 `SessionRunningRegistry`. 同一 Session 同时只能运行一个 Turn 或手动 Compact. 队列通过 `startTurn` 调用 `TurnExecutor.start()`, 再由 `attachTurn` 消费返回句柄的事件流. `completion` 返回最终结果.

```text
队列同步领取输入 -> 创建 running Turn
  -> 准备模型, Prompt, 工具和附件
  -> 保存 reminder, 内部续接与用户输入
  -> 确认队列输入已经保存
  -> 投影有效历史, 运行 AgentLoop
  -> 每次先保存消息, 再让 AgentLoop 继续
  -> 提交 completed / failed / aborted
  -> 清理消息, 工具, 交互和需要暂停的 Goal
  -> 释放运行占用, 通知队列
  -> 交付终态事件与 completion
```

本轮准备时确定模型, 推理强度, 工具, 权限模式, 人设和 TTS 选择. 后续设置变化影响下一次准备. 会话批准仍可供当前和后续工具调用共享.

Reminder 先于用户输入保存, 后续迭代复用. Task 提醒只有在这条消息保存后才确认已交付. 内部续接单独保存为隐藏消息, 不伪装成用户输入.

Turn 完成与宿主的 Memory 提取登记在同一 SQL 事务中提交. 消息补全, 工具关闭, 交互清理和必要的 Goal 暂停完成后才释放 Session. 删除协调需要等待 `abortAndAwait()`, 只发送取消信号不代表执行已经退出. Scratchpad 等派生的后台子代理退出后清理, 不继续占用已完成 Turn.

`TurnHandle.events` 只允许一个消费者. 调用迭代器的 `return()` 会请求取消. 暂停读取不会自动取消, 当前事件数组没有容量上限. 最后清理时保存失败会拒绝 completion, 不广播成功结束.

## 排队输入与续接

普通发送统一经过 `enqueue()`, 不论当前空闲, 正在运行还是手动压缩中. 队列只存在于进程内存, 重启不恢复.

| 交付位置 | 优先顺序 |
| --- | --- |
| 新 Turn | 先合并当前用户输入, 没有输入则交付后台通知, 再没有才生成 active Goal 续接. 用户输入也可附带 Goal 短提示. |
| 完整迭代之间 | 当前 active Goal 最新编辑, 后台通知, 已标记立即引导的用户输入. |
| 执行失败或中止 | 按提交顺序把全部未保存用户输入退回草稿, 已保存消息不退回. |

立即引导不打断活跃工具. AgentLoop 在 Assistant 和本批 ToolResult 全部完成后检查, 无工具的正文回复后也检查. 多条文本用空行合并, 附件与 Skill 引用保持顺序.

领取是临时操作. 保存 Message 后再 `acknowledge()`, 准备或写入失败则 `release()`. `user_message_stored` 携带消费的队列 ID, 前端据此把等待气泡替换成正式消息. 这些 ID 不写 SQL.

后台通知只包含执行 ID 和状态. 模型通过 `SubagentAwait` 或 `ProcessOutput` 读取详情. 尚未交付的通知按执行身份去重; 已通过 SubagentAwait 读到完整终态时, 撤掉未领取的同一通知.

Goal 编辑绑定编辑发生时正在运行的 Turn, 交付时读取最新 SQL 正文. 同一交付点前的多次编辑只保留最新正文. 当前 Turn 达到迭代上限时, 仍 active 的同一 Goal 可以由下一 Turn 继续; Turn completed 不代表 Goal 成功. 停止或失败会暂停仍 active 的同一 Goal, 包括其更新后的版本, 不影响后来创建的另一目标. 关闭 Goal 不会直接中止当前 Turn.

目前没有整个 Goal 的累计 Token 上限和跨 Turn 空转判定. 现有迭代上限只限制单个 Turn.

删除与归档先关闭 Session 新工作入口, 再清理待交付输入和通知. 归档期间忽略迟到通知. 应用关闭先停止队列续接, 再停止执行.

## Context 与消息保存

`prepareContextInput()` 同时用于实际执行与空闲估算. 它准备 Prompt 和工具定义, 不创建 Turn 或执行器, 不调用模型. 空闲估算统计已保存的有效历史, 不包括草稿和未来 reminder. 图片处理见 [Context](../context/README-zh.md).

`TurnMessageWriter` 在首个非空内容到来时创建 Assistant 行, 后续按 blockIndex 更新. 完整 tool_use 先保存, AgentLoop 才启动工具. 每个 ToolResult 独立保存为 User Message, 然后确认执行状态. 中断时标记未完成 Assistant, 并给尚无结果的工具补取消占位, 保留完整配对.

舞台控制标签在保存和发布正文前清理. Turn 保存参与对话的角色稳定名称. 投影历史时只给其他角色的普通 Assistant 正文添加名称前缀, 不修改落盘正文, 工具块, 推理块和摘要.

真实调用用量与 Context 占用分开处理. 主调用更新 Session 上下文球, 子代理只记用量, 不替换该球. Provider 输入统计可以校正估算, 追加消息后重新标为估算.

自动标题只使用默认标题下的首条普通用户消息. 优先显式文本, 再用粘贴预览, 文件或图片, 最后使用 Skill 名称. 最多保存 30 个完整可见字符, 不调用模型. 改名失败不丢弃已保存消息.

## Compact 与 fork

每次模型请求前, `createPrepareAgentIteration()` 组装完整有效消息, 再交给 Compact 改写. System Prompt 和工具计入请求预算, 不作为普通历史消息保存.

Turn 维护与模型消息逐位置对应的 SQL ID 数组. 模型专用引导占 `undefined` 位置. Macro 取被覆盖前缀最后一个已保存 ID 作为覆盖边界, 保存后把对应 ID 前缀替换成新摘要 ID, 不能仅凭数组下标推断 SQL 范围.

新 fork 绑定某一次父请求的固定前缀, 等完整父 Assistant 保存后交付. 同一请求的兄弟 fork 共用一次延迟构建. 取消一个子代理只取消自己的等待, 父请求失败则释放等待者. 继续旧子代理使用自身历史, 不再次复制父历史.

子代理使用独立 Compact 闭包, 自己的消息表和不含当前角色人设的工作 Prompt. 工具只能从父 Pool 继续筛选, 不提供 Memory 查询, Goal/Task 管理, 递归派发和 AskUser. 模型原生推理按记录的生成来源决定如何重放.

## 交互与 Plan

`SessionInteractionQueue` 把 Permission 和 AskUser 放入同一 Session FIFO. 只有队首能回答或超时, 排队时间不计入超时. 不同 Session 可以同时等待. Turn 清理不取消子代理 Run 的批准, Run 与 Session 清理分别删除自身请求.

批准事件直接通过宿主 Session 出口发布, 不依赖父 Turn 事件流. 会话批准先保存规则再发布 resolved 并继续执行. AskUser 取消返回明确取消结果, 不是成功的空答案.

Plan 在准备时按明确的内置工具 ID 筛选. 保留调查与读取, 包括 Capture, Memory, Narrative 和部分 Task/Scratchpad 读取; 排除 Shell, 写入, Subagent, AskUser 和 MCP. allow 规则不能把已排除工具加回来.

## 阅读与测试

从 [sessionContinuationQueue.ts](./sessionContinuationQueue.ts) 和 [turn.ts](./turn.ts) 开始, 再看 [prepareTurn.ts](./prepare/prepareTurn.ts), [prepareAgentIteration.ts](./prepare/prepareAgentIteration.ts), [turnMessageWriter.ts](./turnMessageWriter.ts) 和 [turnLoopEvents.ts](./turnLoopEvents.ts).

运行 `pnpm --filter @ema-agent/turn test` 和 `pnpm --filter @ema-agent/turn typecheck`. 测试使用安排好的模型事件和临时或内存数据库, 验证队列交付, SQL 消息, 权限等待, Compact ID, fork 时机, Context 用量与最后清理, 不需要付费模型请求.
