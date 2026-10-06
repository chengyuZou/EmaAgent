# Agent

`src/agent` 只实现一个 Agent 的 `LLM → Tool → Result` 循环，以及父 Agent 派生的子 Subagent。根 Turn、Session 历史、Context、Compact、权限装配和 ToolPool 发现都不属于本包；循环只产 `AgentLoopEvent`，持久化由事件消费方（Turn / SubagentExecutor）在 yield 恢复点完成。

`SubagentStore` 管稳定身份和每次 Run 的 SQL 事实; `SubagentEvent` 由执行器发布执行进度、已持久化的消息更新和终态 Run. Desktop 在启动/终态时刷新身份列表中的对应身份; 未收到的历史仍通过 HTTP 查询, 不把执行流当成完整历史重放.

`SubagentEvent.tool_result` 携带 `subagentId`、模型可见的 `toolName` 和原始 `result`. Desktop 用工具名称筛选工作区差异刷新, 不反查聊天消息; 名称由 `SubagentExecutor` 按本次调用 ID 从 `tool_use_completed` 配对, 结果发出后立即释放配对记录.

## 唯一循环

```text
runAgentLoop(input)
  ├─ prepareIteration({ messages })
  │    └─ 外层返回中立 LlmRequest 与可能被 Compact 改写的工作历史
  ├─ CallLlm(request)                  // 模型身份在装配层创建点冻结
  ├─ 持续发出内容事件、单次调用 Usage 与 AgentLoop 累计 Usage
  ├─ tool_use 完整事件被消费并持久化
  ├─ generator 恢复后才启动 StreamingToolExecutor
  ├─ ToolResult 事件被消费并持久化
  ├─ generator 恢复后才 acknowledgeResult
  └─ 完整历史保存后领取安全点输入; 无 ToolCall 且无追加输入时结束, 否则继续
```

一个普通根 Turn 只运行一个根 `runAgentLoop()`。循环内每次 `LLM → Tool → Result` 推进统一叫 Agent iteration；子 Subagent 各自复用同一个循环。

循环的恢复与继续路径:

1. **PTL 单次重试**：Provider 在尚未产出任何响应前报上下文超限，循环以 `recoveryReason: 'context_window_exceeded'` 重新请求同一次迭代；是否 Compact 由外层实现决定；
2. **max_tokens 三段**：先升级重试（顶到预算上限、半截作废、不注入任何消息）→ 再注入续写提示拼接输出 → 都失败判 `output_recovery_failed`；
3. **工具或追加输入后继续**: 工具批完成后进入下一 iteration. 无工具的正文生成结束后也检查追加输入, 有输入则继续当前循环, 不把它留给已经结束的 Turn.

另有空转软引导: 连续 3 轮完全相同的工具批次（工具名+参数一致）在迭代边界注入一次提醒消息让模型换方法. 单次循环达到 `maxIterations` 产出 `max_iterations`, 是否失败或另起根 Turn 由调用方决定. 这不提供跨 Turn 的空转判定或总体用量上限.

## AgentLoop 的真实输入

`types.ts` 只定义会改变循环行为的输入：

- `AgentLoopInput.messages`：单一工作历史（持久基线 + 本轮种子消息），循环在其上追加；`prepareIteration` 每次返回的版本可能已被 Compact 改写，循环整体替换继续使用；
- `PrepareAgentIteration` 闭包：为下一次迭代准备 `LlmRequest`。装配（assembleContext → Compact → Macro 落库 → 再装配）涉及持久化与 Context 知识，全归外层实现；ToolPool 也由实现闭包冻结捕获，故输入里没有显式 tools 字段——工具定义经返回的 `LlmRequest.tools` 到达 Provider；
- `ToolExecutorFactory`：每次 LlmCall 创建全新执行器。创建时机是外层绑定工具进度、Permission 与 AskUser 事件出口的唯一位置，故必须是工厂；`wake` 是执行器→循环的唤醒针，没有它循环只能轮询。
- `takeNextIterationMessages`: 完整 Assistant 和本批 ToolResult 已保存后才调用, 无工具的最终正文也检查. Turn 用它领取目标编辑, 立即引导和后台完成通知, 不取消在途请求或切开 tool_use/tool_result 配对.

`runAgentLoop()` 不接收 `sessionId/turnId/providerId/modelId`, 也不导入 Context、Compact、Permission、Sandbox 或 BuiltinTools. 失败不是循环相位: Provider/执行错误以异常逃出 generator, 终态由根 Turn 或进程级 `SubagentExecutor` 收口.

## 事件与持久化边界

`AgentLoopEvent` 只表达循环本身已经发生的事实，不携带根 Session/Turn 身份。根执行由 Turn 消费事件：

1. 先更新 Message/Usage/ToolExecution 等本地事实；
2. 再恢复 AgentLoop generator；
3. 最后由 Turn 发布带根身份的 `TurnEvent`。

SSE 不是数据库写入触发器。Agent 也不透明中转 Tool、Permission、Task 等其他业务事件；这些事件由外层在创建 ToolExecutor 时绑定到各自出口。

每次实际 Provider 请求都有独立 `llmCallId`。`llm_call_usage_updated` 是该调用的累计快照，`llm_call_finished` 是唯一终态；`agent_usage_updated` 是本 AgentLoop 全部物理调用的累计值。上下文恢复与输出重试都是新的物理调用，不复用身份。

## 子 Subagent

`SubagentExecutor` 只负责：

- 新建稳定身份与首次 Run, 或给已有身份新建 Run; 配置和终态按 RunId 与身份在同一事务内更新, 崩溃恢复收口 running;
- 建立父取消信号到子 Agent 的取消树；
- 管理全进程并发上限、前台等待、后台转交与取消；
- 调用外层注入的 `PrepareSubagent`，随后运行同一个 `runAgentLoop()`；
- 在恢复子 Agent generator 前, 先把完整 `tool_use` 写入 Assistant Message, 再启动对应工具; Assistant 闭合时补全同一条 Message, ToolResult 逐条落库.

`subagents/` 下两个存储各司其职: `SubagentStore` 组合身份与 Run Repo, 身份不带统计, Run 保存当次结果和统计; `SubagentMessagesStore` 管同一子代理跨 Run 的消息历史, 在工具启动前记录 `tool_use`, 消息闭合后补全同一条 Assistant, 并逐条记录 ToolResult. Assistant 行内部保留 `AssistantBlock[]` 的原始块顺序, 不以每轮都会重新计数的 `blockIndex` 充当跨轮身份.

子代理 Message 继承 Session 的基础 Message, 共用正文解析和 Context 的 `projectMessages` 投影. 自身输出的来源从 Run 读取; fork 复制来的父 Assistant 可能来自多个父 Turn/模型, 因此单独保留原始来源. 所有消息用 `createdAt/id` 游标, 不另设 sequence.

fork 的父前缀由 Turn 在发起调用所属的父 Assistant 完整落库后交付. Agent 消息层生成新消息 ID、复制有效前缀并补父工具调用的占位结果, 不改父 Session. 摘要覆盖 ID 在副本内则映射, 不在则留 null, 以摘要自身位置为覆盖边界, 不复制被摘要覆盖的旧历史. 继续旧 ID 只加载子代理自己的有效历史并追加本次 reminder/任务, 不再 fork.

`PrepareSubagentInput.messageStore` 是消息存储入口, `messageIds` 则是与模型历史逐条对齐的 SQL ID 数组. 执行器先持久化 Assistant/ToolResult, 将 ID 暂存到 `pendingMessageIds`, 再按 `model_history_appended` 移入历史 ID 数组. Macro 保存摘要后同时替换这段 ID 前缀, 和根 Turn 使用同一压缩逻辑, 但写各自的消息表.

`PrepareSubagent` 决定独立上下文或 fork 上下文、模型、Prompt、ToolPool 和工具执行环境. SubagentTool 不再提供 Role, 启动参数不携带角色 System 或角色工具排除列表. 子任务范围由 prompt 表达, 工具池仍从父 Pool 按统一的子代理排除规则收窄. V1 子 Agent 深度为 1: 子 Agent 没有再次派生子 Agent 的能力.

`Subagent` 只表示子 Agent; 根 Agent 不创建 Subagent. 身份属于 Session, 每次 Run 通过 `parentToolCallId` 关联发起工具; 父 Turn 取消归属只在当前执行上下文保存, 不进入 AgentLoop 输入.

前台等待超过 2 分钟只改变结果所有者和父 Turn 取消关系, 同一条执行不会重启. 自然终态先写 `subagent_runs.final_text`, 再向 Session 队列发送 `subagentId + status`; 完整结果可由 `SubagentAwait` 按稳定 ID 读取当前/最近 Run. 应用启动只把遗留 `running` 收口为失败, 不扫描终态并启动新 Turn.

模型新建时未指定则沿用父模型, 继续时未指定则沿用身份记录最近实际使用的模型; 显式配置无效直接报错. Permission 和 reasoningEffort 每次取父 Turn 当前冻结值, 身份上的最近配置仅供展示. 旧 Role 已移除; 普通/fork/继续共用产品静态规则, 不带角色与 SessionMode, 按实际子模型和子 ToolPool 装配动态 System, 最后补纯工作委派说明.

前后台子工具通过宿主提供的 askPermission 共用 Session FIFO, 不再因子代理身份被视为 headless.
请求按 subagentId/runId/toolCallId 定位来源与执行, 父 Turn ID 仅保留发起关联.
`SubagentExecutorDeps.onRunFinished(runId)` 在执行完成或异常退出后的统一收尾中调用一次,
宿主负责清理这次 Run 的批准请求, Agent 包不导入队列. 转后台保持原 Run 和工具等待,
父 Turn 结束只终止仍在前台的子代理; Desktop 从 Session 消费批准, 标明来源, 按 sessionId/toolCallId 回答, 不依赖父 Turn.

`SubagentExecutor.start` 返回 `{subagentId, runId}`, ToolResult 的 data 和 error 独立保存. Run 创建后的失败/取消通过 `ToolExecutionError` 保留两个 ID, 未开始的失败不伪造引用. `SubagentAwait` 的成功结果也携带实际 RunId.

实时 `message_updated` 在 SQL 写入后发送完整原生 Message 和真实 MessageId; delta 与闭合更新同一条. `iteration_started` 提供本次实际 Run 配置, completed/failed/aborted 在终态 SQL 提交后携带完整 Run. 终态属于对应 Run, 不代表该身份后来启动的新 Run 也已结束. Desktop 按稳定子代理 ID 打开连续消息历史, 所有 Run 与 fork 前缀一起显示. Message 窗口用 createdAt/id 双向游标并按 ID 合并实时更新, 不要求 Run 有起始任务消息. 已有身份没有消息时返回空窗口, 不报未找到.

## 文件结构

```text
src/agent/
├─ agentLoop.ts
├─ agentLoopState.ts
├─ types.ts
├─ events.ts
├─ settings.ts
├─ subagentExecutor.ts
├─ subagents/
│  ├─ types.ts
│  ├─ subagentStore.ts
│  └─ subagentMessagesStore.ts
└─ tests/
```

没有单独的 `errors.ts`：当前没有需要调用方按类型分支处理的 Agent 专属错误，创建空错误目录只会形成龟壳。预算错误及实现迁入 Turn 时由 Turn 定义。

## 依赖方向

```text
turn ──> agent ──> llm / tools / session（共用 Message 正文）
                 └─ storage（只用于 Subagent）
```
