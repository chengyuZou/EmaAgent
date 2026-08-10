# Agent

`src/agent` 只实现一个 Agent 的 `LLM → Tool → Result` 循环，以及父 Agent 派生的子 AgentRun。根 Turn、Session 历史、Context、Compact、权限装配和 ToolPool 发现都不属于本包。

## 唯一循环

```text
runAgentLoop(input)
  ├─ prepareIteration(history, currentMessages)
  │    └─ 外层返回中立 LlmRequest 与可能压缩过的工作历史
  ├─ LanguageModel.stream(request)
  ├─ 持续发出 text / thinking / tool_use / usage 事实
  ├─ tool_use 完整事件被消费并持久化
  ├─ generator 恢复后才启动 StreamingToolExecutor
  ├─ ToolResult 事件被消费并持久化
  ├─ generator 恢复后才 acknowledgeResult
  └─ 没有 ToolCall 时结束；否则准备下一次 Agent iteration
```

一个普通根 Turn 只运行一个根 `runAgentLoop()`。循环内每次 `LLM → Tool → Result` 推进统一叫 Agent iteration；子 AgentRun 各自复用同一个循环。

## AgentLoop 的真实输入

`types.ts` 只定义四个会改变循环行为的输入：

- `PrepareAgentIteration`：外层为下一次迭代准备 `LlmRequest`；Context、Compact、Prompt 和 ToolPool 均封装在实现闭包中；
- `AgentBudget`：根 Turn 与全部子 Agent 共用的额度消费接口，实现归 Turn；
- `ToolExecutorFactory`：创建本次调用的流式工具执行器；Tool 进度、Permission 与 AskUser 事件由创建它的 Turn 直接接收，不进入 Agent 事件；
- `AgentLoopInput`：工作历史、当前消息、LLM、取消信号和最大迭代次数。

`runAgentLoop()` 不接收 `sessionId/turnId/providerId/modelId`，也不导入 Context、Compact、Permission、Sandbox 或 BuiltinTools。Provider 在尚未产生任何响应事件前报告上下文超限时，循环以 `context_window_exceeded` 原因重新请求同一次迭代；真正的压缩与 Macro 持久化仍由 Turn 完成。

## 事件与持久化边界

`AgentLoopEvent` 只表达循环本身已经发生的事实，不携带根 Session/Turn 身份。根执行由 Turn 消费事件：

1. 先更新 Message/Usage/ToolExecution 等本地事实；
2. 再恢复 AgentLoop generator；
3. 最后由 Turn 发布带根身份的 `TurnEvent`。

SSE 不是数据库写入触发器。Agent 也不透明中转 Tool、Permission、Task 等其他业务事件；这些事件由 Turn 在创建 ToolExecutor 时绑定到各自出口。

## 子 AgentRun

`SubagentSpawner` 只负责：

- 创建 AgentRun 行并写唯一终态；
- 建立父取消信号到子 Agent 的取消树；
- 消费共享 `AgentBudget.enterSubagent()`；
- 管理后台等待与取消；
- 调用 Turn 注入的 `PrepareSubagent`，随后运行同一个 `runAgentLoop()`；
- 在恢复子 Agent generator 前，把每个可展示的内容事实写入 `AgentRunTranscript`。

`PrepareSubagent` 决定 clean context 或 fork context、模型、Prompt、ToolPool 和工具执行环境，因此这些业务不会重新长回 Spawner。V1 子 Agent 深度由父 ToolPool 是否提供 `SubagentSpawnerPort` 决定，不在 AgentLoop 里复制递归策略。

`AgentRun` 只表示子 Agent；根 Agent 不创建 AgentRun。持久记录继续保存父 `turnId` 外键，这是 AgentRun 自己的归属事实，不会进入 AgentLoop 输入。

## 文件结构

```text
src/agent/
├─ agentLoop.ts
├─ agentLoopState.ts
├─ types.ts
├─ events.ts
├─ settings.ts
├─ subagentSpawner.ts
├─ runs/
│  ├─ types.ts
│  ├─ agentRunStore.ts
│  └─ agentRunTranscript.ts
└─ tests/
```

没有单独的 `errors.ts`：当前没有需要调用方按类型分支处理的 Agent 专属错误，创建空错误目录只会形成龟壳。预算错误及实现迁入 Turn 时由 Turn 定义。

## 依赖方向

```text
turn ──> agent ──> llm / tools
                 └─ ids / storage（只用于 AgentRun）
```

本批物理删除了 `TurnPolicy`、Agent 内 `TurnBudget`、Scratchpad 读取器、跨域事件联合、双层 transcript 投影和未接线的子 Agent mailbox。下一批由 `src/turn` 实现 `PrepareAgentIteration`、`AgentBudget` 与 `PrepareSubagent`，并删除旧 `src/turnExecution`，不允许给旧接口加适配层。
