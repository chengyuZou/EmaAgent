# Turn

> 状态：目标接口已冻结，`src/turnExecution` 尚待整体并入并删除。

`src/turn` 拥有一次完整交互：从建立 Turn 身份、写入用户输入，到运行一个根 AgentLoop、持续保存模型与工具事实，再提交唯一终态。

## 唯一公开入口

```ts
interface TurnExecutor {
  start(input: StartTurn): TurnHandle;
  abort(sessionId: SessionId, turnId: TurnId, reason: string): boolean;
}

interface TurnHandle {
  sessionId: SessionId;
  turnId: TurnId;
  events: AsyncIterable<TurnEvent>;
  completion: Promise<TurnOutcome>;
}
```

若以后实现运行中追加输入，再显式增加 `steer()`；V1 当前没有真实行为时不预留空接口。

`TurnExecutor` 是唯一根执行入口。删除 `RootAgentExecution`，不能换名保留 `RootAgent/TurnRuntime/TurnEngine/Orchestrator` 形成第三层。

## 普通 Turn

```text
start
  → SessionStore.assertWritable
  → ActiveTurnRegistry 注册同 Session 唯一活动 Turn
  → TurnStore.insert（创建即 running，无持久 pending）
  → prepareTurn：冻结模型、连接、设置、Prompt、Skill、ToolPool
  → 写 initial user Message
  → runAgentLoop
       → prepareLlmCall
       → AgentLoopEvent
       → TurnMessageWriter 持久化
       → TurnEvent
  → 收口 assistant Message
  → TurnStore 写一次 completed/failed/aborted
  → 取消本 Turn 的 Permission/AskUser
  → 释放 ActiveTurn
```

确定性的 `/compact` Command 可以创建 `triggerType=command` 的 Turn，但直接调用 Compact 用例，不伪造 AgentLoop。

## 每次 LlmCall

Turn 注入给 Agent 的 `PrepareLlmCall` 固定执行：

```text
assembleContext(history)
  → 未超预算：返回 LlmRequest + 原 history
  → 超预算：compact(history)
       → micro：用新 history 再 assemble
       → macro：事务写 summary + 覆盖游标，成功后再 assemble
       → unchanged：沿用原 candidate
```

Context 与 Compact 互不导入；Agent 也不导入它们。Provider 报超限时，Agent 只在尚未产生可见输出时以同一个 `llmCallId` 请求一次 `forceCompact=true` 的重准备。

根 ToolPool、Prompt、模型和本轮 Skill 内容都在 Turn 内冻结。MCP 重连不得在 Turn 中途扩权；子 Agent ToolPool 只能收窄。

## 持久化顺序

根执行的事实源不是 SSE，也不是 LlmCall 结束时的一次大 JSON：

```text
第一个 text/thinking delta
  → 创建 assistant block
后续 delta
  → 按 blockIndex 更新同一 block
tool_use_complete
  → 先落库 tool_use
  → 再允许 ToolExecutor.start()
tool_result
  → 先落库 ToolResult
  → 再 acknowledgeResult()
```

进程崩溃后，已写入内容保留，未结束 assistant Message 标记 `interrupted=true`；没有 ToolResult 的 tool_use 不自动重放。

Turn 先提交 Message/Turn 状态，再发 `TurnEvent`。Application Server 稳定消费一次并 fan-out 给 SSE、Speech 和 UI；浏览器断连不能影响 Turn 持久化。

## 预算与用户决定

- `TurnBudget` 覆盖根 Agent 与全部子 Agent的时间、Token、ToolCall 和并发子 Agent额度；
- Agent 只消费 `AgentBudget` 接口；
- `DecisionQueue` 统一排列 Permission 与 AskUser，但两类 payload/结果保持各自类型；
- Session 内 FIFO、跨 Session 并行；只有队首计时；Turn 结束统一取消；
- 这不是 Codex 的 TurnSteer，也不持久恢复悬空 Promise。

## 目标目录

```text
src/turn/
├─ README.md
├─ events.ts
├─ errors.ts
├─ turnStore.ts（生命周期 + 运行态 + 删除守卫 + 导航查询 + rewind）
├─ activeTurnRegistry.ts
├─ turnExecutor.ts
├─ prepareTurn.ts
├─ prepareLlmCall.ts
├─ prepareTurnTools.ts
├─ turnMessageWriter.ts
├─ turnBudget.ts
├─ mediaCompatibility.ts
├─ eventChannel.ts
├─ decisionQueue.ts
└─ tests/
```

每个文件只有上述事实职责；不建立 `runtime/engine/orchestrator/common`。

## `src/turnExecution` 的去向

| 当前文件 | 目标 |
|---|---|
| `turnExecutor.ts` | 并入 `src/turn/turnExecutor.ts`，成为唯一根入口 |
| `rootAgentExecution.ts` | 删除；事件消费、持久化和取消直接进入 TurnExecutor |
| `turnContext.ts` | 删除；旧 Snapshot/Contribution API 不迁移，改用 `prepareLlmCall.ts` |
| `turnTools.ts` | 重写为函数式 `prepareTurnTools.ts` |
| `turnPreparation.ts` | 重写为 `prepareTurn.ts` |
| `iterationTranscript.ts` | 删除；由 `turnMessageWriter.ts` 持续落库 |
| `awaitUserAnswer.ts` | 删除重复 Port，直接使用 `decisionQueue` |
| `turnEventChannel.ts` | 迁为 `eventChannel.ts` |
| `mediaCompatibility.ts` | 迁入 Turn |
| `executionProfilePolicy.ts` | 合并进 `prepareTurn/prepareTurnTools`，不单建 Policy 层 |
| `types.ts/errors.ts` | 按 Turn 真实公共类型收回 |

迁移完成后物理删除包、workspace 项和 `@ema-agent/turn-execution` 依赖，不留 re-export。

## 依赖方向

```text
turn ──> session / agent / context / compact / prompts / providers / skills / tools
```

Turn 不实现某个 Provider、Tool、Memory、Narrative、Speech 或 HTTP 协议。Memory 完成后处理和 Speech 输出装饰由 Application Server 显式消费 TurnEvent，不得覆盖根终态。
