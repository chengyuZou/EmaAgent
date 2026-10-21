# Agent

[English](./README.md)

Agent 执行 Turn 和子代理共用的模型/工具循环. 宿主提供模型调用, 每次迭代的请求准备, 工具执行器和可选的迭代间追加消息. 子代理执行还保存稳定身份, 每次 Run 和消息历史.

## 循环与保存顺序

`runAgentLoop(input)` 是异步生成器. 每次迭代调用 `prepareIteration`, 接受返回的工作历史, 创建工具执行器并读取 `CallLLM` 事件.

消费方必须保存当前事件后再恢复生成器:

```mermaid
sequenceDiagram
  participant Loop as AgentLoop
  participant Host as Turn 或 SubagentExecutor
  participant Tools as StreamingToolExecutor
  Loop-->>Host: tool_use_completed
  Host->>Host: 保存完整工具调用
  Host->>Loop: 恢复生成器
  Loop->>Tools: addTool
  Loop-->>Host: assistant_message_completed
  Host->>Host: 保存完整助手块
  Loop-->>Host: tool_result
  Host->>Host: 保存结果
  Host->>Loop: 恢复生成器
  Loop->>Tools: acknowledgeResult
  Loop-->>Host: model_history_appended
```

模型仍在生成时, 完整参数保存后的工具就可以开始. 每个工具结果在工作历史中各占一条 user 消息. 推理块保留原生状态和生成来源, 供 adapter 判断重放. 执行器在结果或等待用户状态改变时通知循环, 无需反复查询.

完整助手/工具历史形成后, `takeNextIterationMessages` 可以提供追加输入. 无工具回复也会检查, 不会打断当前生成或拆开工具配对. 生成器提前退出时停止未结束工具.

## 恢复与限制

- 尚未收到任何响应事件就发生窗口超限时, 同一迭代内允许重试一次. 宿主收到 `recoveryReason: 'context_window_exceeded'`, 决定是否压缩.
- 无工具的 `max_tokens` 回复会保留文本并追加续写提示. 再次截断时以 `output_recovery_failed` 停止.
- 连续三次完全相同的工具批次会注入一次换方法提醒. 比较按排序后的工具名和序列化参数进行.
- 达到 `maxIterations` 时返回 `max_iterations`, Turn 如何结束由宿主决定.

每次真实模型请求使用新的 `llmCallId`. 单次调用用量事件表示该调用累计值, Agent 用量累加它们的增量. 窗口重试是新请求, 不是新迭代. 其他模型错误向宿主抛出.

默认每个循环最多 50 次迭代, 全进程 32 个并发子代理, 设置范围分别为 30-100 和 1-128. 所有 Session 共用子代理上限, 满额时拒绝新的 Run, 不自动排队. 由宿主读取并应用设置.

## 子代理

`SubagentExecutor.start` 返回 `{ subagentId, runId }`. 身份属于 Session, 保存最近一次准备成功的配置. 每个 Run 单独保存配置, 结果, 用量和终态. 继续已有身份会创建新 Run, 不覆盖以往执行.

宿主 `PrepareSubagent` 选择模型, 上下文, Prompt 和工具. 新建可以使用独立历史或固定 fork 前缀, 继续则读取自身历史. fork 生成新 Message ID, 保留继承回复的模型来源, 并为父工具调用补占位结果. 子代理自身输出从所属 Run 取得来源.

前台执行跟随父 Turn 取消信号. 转后台只解除该关系, 不重启执行. 同时只有一个结果接收方:

| 接收方 | 交付方式 |
| --- | --- |
| `subagent_call` | 首次工具调用等待本次结果. |
| `subagent_await` | 后续 SubagentAwait 等待正在运行的结果. |
| `session_notification` | 完成后通知 Session 队列, 模型按 ID 查询已保存结果. |

取消 await 只停止等待, 不停止后台执行. Session/Turn 删除和应用关闭有独立取消入口. 先保存终态, 再发送终态事件或后台完成通知. `onRunFinished(runId)` 通知宿主清理该 Run 的批准请求. 启动恢复把遗留 running Run 标成失败, 不重新执行.

`SubagentMessagesStore` 用同一个 Message ID 保存流式与闭合内容. 历史 ID 数组跟随 `model_history_appended`, 让压缩能将覆盖前缀映射到 SQL 游标. 消息更新携带已保存内容, 终态事件携带具体 Run, 不把身份当前状态猜成本次执行状态.

## 阅读与检查

先看 [agentLoop.ts](./agentLoop.ts) 的生成器契约, 再看 [subagentExecutor.ts](./subagentExecutor.ts) 的结果接收方. `subagents/` 保存基于 SQL 的身份/Run 和消息. 实际消费方包括 [Turn](../turn/turn.ts), [子代理准备](../turn/prepare/prepareSubagent.ts) 和 [Server composition](../../apps/server/src/composition/turn.ts).

`pnpm --filter @ema-agent/agent test` 检查事件顺序, 重试, 原生推理, 取消, fork 历史, 多次 Run 和 SQLite 保存. 测试使用受控模型与执行器替身, 不调用付费 API.
