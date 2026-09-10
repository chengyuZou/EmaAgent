# Agent

`src/agent` 只实现一个 Agent 的 `LLM → Tool → Result` 循环，以及父 Agent 派生的子 AgentRun。根 Turn、Session 历史、Context、Compact、权限装配和 ToolPool 发现都不属于本包；循环只产 `AgentLoopEvent`，持久化由事件消费方（Turn / AgentRunExecutor）在 yield 恢复点完成。

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
  └─ 没有 ToolCall 时结束；否则准备下一次 Agent iteration
```

一个普通根 Turn 只运行一个根 `runAgentLoop()`。循环内每次 `LLM → Tool → Result` 推进统一叫 Agent iteration；子 AgentRun 各自复用同一个循环。

**恢复路径固定三条，不再新增**：

1. **PTL 单次重试**：Provider 在尚未产出任何响应前报上下文超限，循环以 `recoveryReason: 'context_window_exceeded'` 重新请求同一次迭代；是否 Compact 由外层实现决定；
2. **max_tokens 三段**：先升级重试（顶到预算上限、半截作废、不注入任何消息）→ 再注入续写提示拼接输出 → 都失败判 `output_recovery_failed`；
3. **工具后续跑**：模型调用工具就进入下一 iteration，这是唯一"正常"继续。

另有空转软引导：连续 3 轮完全相同的工具批次（工具名+参数一致）在迭代边界注入一次提醒消息让模型换方法，不硬停、不新增恢复分支；硬兜底归 `maxIterations`。

## AgentLoop 的真实输入

`types.ts` 只定义会改变循环行为的输入：

- `AgentLoopInput.messages`：单一工作历史（持久基线 + 本轮种子消息），循环在其上追加；`prepareIteration` 每次返回的版本可能已被 Compact 改写，循环整体替换继续使用；
- `PrepareAgentIteration` 闭包：为下一次迭代准备 `LlmRequest`。装配（assembleContext → Compact → Macro 落库 → 再装配）涉及持久化与 Context 知识，全归外层实现；ToolPool 也由实现闭包冻结捕获，故输入里没有显式 tools 字段——工具定义经返回的 `LlmRequest.tools` 到达 Provider；
- `ToolExecutorFactory`：每次 LlmCall 创建全新执行器。创建时机是外层绑定工具进度、Permission 与 AskUser 事件出口的唯一位置，故必须是工厂；`wake` 是执行器→循环的唤醒针，没有它循环只能轮询。
- `takeNextIterationMessages`：只有一整批 ToolResult 已经写成完整历史后才调用。Turn 用它领取立即引导输入和本进程后台完成通知，绝不切开 tool_use/tool_result 配对。

`runAgentLoop()` 不接收 `sessionId/turnId/providerId/modelId`, 也不导入 Context、Compact、Permission、Sandbox 或 BuiltinTools. 失败不是循环相位: Provider/执行错误以异常逃出 generator, 终态由根 Turn 或进程级 `AgentRunExecutor` 收口.

## 事件与持久化边界

`AgentLoopEvent` 只表达循环本身已经发生的事实，不携带根 Session/Turn 身份。根执行由 Turn 消费事件：

1. 先更新 Message/Usage/ToolExecution 等本地事实；
2. 再恢复 AgentLoop generator；
3. 最后由 Turn 发布带根身份的 `TurnEvent`。

SSE 不是数据库写入触发器。Agent 也不透明中转 Tool、Permission、Task 等其他业务事件；这些事件由外层在创建 ToolExecutor 时绑定到各自出口。

每次实际 Provider 请求都有独立 `llmCallId`。`llm_call_usage_updated` 是该调用的累计快照，`llm_call_finished` 是唯一终态；`agent_usage_updated` 是本 AgentLoop 全部物理调用的累计值。上下文恢复与输出重试都是新的物理调用，不复用身份。

## 子 AgentRun

`AgentRunExecutor` 只负责：

- 创建 AgentRun 行并写唯一终态（CAS 状态机，幂等终态，崩溃恢复收口 running）；
- 建立父取消信号到子 Agent 的取消树；
- 管理全进程并发上限、前台等待、后台转交与取消；
- 调用外层注入的 `PrepareSubagent`，随后运行同一个 `runAgentLoop()`；
- 在恢复子 Agent generator 前, 把完整 Assistant 消息或 ToolResult 写入 `AgentRunMessagesStore`.

`runs/` 下两个存储各司其职: `AgentRunStore` 管一次运行的状态机与终态统计(一次运行一行); `AgentRunMessagesStore` 管完整 Assistant 消息与 ToolResult 流水. Assistant 行内部保留 `AssistantBlock[]` 的原始块顺序, 不以每轮都会重新计数的 `blockIndex` 充当跨轮身份.

`PrepareSubagent` 决定 clean context 或 fork context、模型、Prompt、ToolPool 和工具执行环境。**角色注册表（general/explore 等）归 `builtinTools/tools/SubagentTool/agentRoles.ts`**——模型经 SubagentTool 选角色，角色 Prompt 与 disallowedTools 经 `SubagentSpawnOptions` 传给 PrepareSubagent 应用。V1 子 Agent 深度为 1：子 Agent 没有再次派生子 Agent 的能力。

`AgentRun` 只表示子 Agent；根 Agent 不创建 AgentRun。持久记录继续保存父 `turnId` 外键，这是 AgentRun 自己的归属事实，不会进入 AgentLoop 输入。

前台等待超过 2 分钟只改变结果所有者和父 Turn 取消关系，同一条执行不会重启。自然终态先写 `agent_runs.final_text`，再向 Session 队列发送 `agentRunId + status`；完整结果可由 `SubagentAwait` 按 id 重复读取。应用启动只把遗留 `running` 收口为失败，不扫描终态并启动新 Turn。

## 文件结构

```text
src/agent/
├─ agentLoop.ts
├─ agentLoopState.ts
├─ types.ts
├─ events.ts
├─ settings.ts
├─ agentRunExecutor.ts
├─ runs/
│  ├─ types.ts
│  ├─ agentRunStore.ts
│  └─ agentRunMessagesStore.ts
└─ tests/
```

没有单独的 `errors.ts`：当前没有需要调用方按类型分支处理的 Agent 专属错误，创建空错误目录只会形成龟壳。预算错误及实现迁入 Turn 时由 Turn 定义。

## 依赖方向

```text
turn ──> agent ──> llm / tools
                 └─ storage（只用于 AgentRun）
```
