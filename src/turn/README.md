# Turn

`src/turn` 拥有一次完整交互：建立 Turn 身份、冻结本轮一切可变事实、运行唯一一个根 AgentLoop、按事件顺序持续落库，并提交唯一终态。

公开入口只有 `turn.ts` 的 `TurnExecutor`；领域词汇（ExecutionProfile/Turn/TurnStatus/TurnStats 等）在叶子包 `@ema-agent/turn-terms`，本包 `index.ts` 对其做表面组合。

## 唯一公开入口

```ts
class TurnExecutor {
  start(input: StartTurn): TurnHandle;
  abort(sessionId: string, turnId: string): boolean;
  abortTool(turnId: string, toolCallId: string): boolean;
  abortAgentRun(turnId: string, agentRunId: string): boolean;
}

interface TurnHandle {
  readonly sessionId: string;
  readonly turnId: string;
  readonly events: AsyncIterable<TurnStreamEvent>; // 单消费者有界通道
  readonly completion: Promise<TurnOutcome>;       // 唯一终态
  abort(): void;
}
```

- `start()` 同步创建并立刻返回句柄：TurnStore 建行（创建即 running、同 Session 唯一活动、`session_busy` 快速失败）→ 事件通道 → 异步泵送准备与主循环。
- `StartTurn` 是判别输入：模型覆盖、附件、KB 范围、选中 Skill。Command/Skill 解析在调用方完成，Turn 不解析 `/` 语法，也不接受 prepare 回调。
- `TurnOutcome` 只有 completed/failed/aborted 三态，与终态事件同一份数据。
- 运行中追加输入（steer）V1 不做，不预留空接口。

## 主链

```text
start
  → TurnStore.startTurn（建行 + 注册活动信号 + 收口同 Session 崩溃残留）
  → prepareTurn（preparation/，一次性冻结）
  │    ├─ settings 快照（agent/compact/attachment/permission mode）
  │    ├─ Session 事实（workspaceRoot/projectId/模型偏好）
  │    ├─ 模型解析：请求覆盖 > Session 偏好；ProviderModels 事实 + resolveConnection + createLlm
  │    ├─ 附件登记（AttachmentStore.addAll）→ 用户消息块 + 模型内容（ref 解析 + 原始图片降级）
  │    ├─ Skill：work 态 freezeSkillPool + 选中正文冻结
  │    ├─ 权限三桶 loadPermissionRuleBuckets
  │    └─ prepareTurnTools：ToolUseContext + 根 ToolPool + askPermission/askUser 口子
  │        → getSystemPrompt（扁平数组，含工具名投影）
  ├─ setModel 回填 Turn 行
  ├─ 写 initial user Message
  └─ runAgentLoop（唯一一个根循环）
       ├─ prepareLlmCall（loop/，每次模型调用前）
       │    ├─ 基线切分：history（唯一可压缩区间）+ currentTurn
       │    ├─ reminder 装配（Memory/Narrative 召回一次缓存，git 仅 work，task/scratchpad 每轮）
       │    ├─ assembleContext → 未超直接返回
       │    └─ 超限 compact：micro 直接重装配；macro 落 kind='summary' 消息（turnId=null，
       │       摘要即覆盖游标）再重装配；返回可能被改写的整体工作历史
       ├─ TurnMessageWriter 流式落库
       └─ 事件翻译 → TurnStreamEvent 通道
  → finishSafely：writer 收口（interrupted + 孤儿 tool_use 合成）→ 交互队列清理
    → 工具与子 Agent shutdown → ActiveTurn 释放
  → TurnStore 一次终态：completed / failed / aborted
```

## 持久化不变量

- **yield 恢复 = 已保存**：`tool_use_completed` 落库后 AgentLoop 才登记调用；`assistant_message_completed` 落库后才允许 `executor.start()`；`tool_result` 落库后才 `acknowledgeResult()`。
- 首个 delta 创建 assistant 消息，后续 delta 用 `updateMessageBlocks` 续写同一消息。
- 终态非 completed 时未完成 assistant 标 `interrupted`；未等到 tool_result 的 tool_use 由 Turn 合成取消结果补配对（buildMessages 只重放完整配对）。
- 先落库，再发事件：SSE 不是持久化触发器。

## 权限与交互

- 权限判定上下文（模式 + 三桶规则）Turn 冻结；settings 源次 Turn 生效，session 源本 Turn 即效。
- 根 Turn 始终 interactive：`askPermission` 口子 = permission_required/resolved 事件 + interactionQueue 等回答 + `allowSession` 经 `applyPermissionUpdate` 沉淀 session 规则（`ruleSuggestion` 来自 Tool 的 ask 决策）。
- 子 Agent headless：`createSubagentExecutor` 不提供 askPermission 口子，中央把 ask 收口为 deny。
- Permission 与 AskUser 统一 toolCallId 锚，共用 `interactionQueue.ts` 的 Session FIFO（跨 Session 并行，Turn 终态统一取消）。

## 子 Agent

- `loop/prepareSubagent.ts`：clean 上下文或 fork 继承（`parentMessages` 在每次根请求装配后 splice 更新）；ToolPool 只从父 Pool 收窄（disallowedTools + 内建拒绝：Subagent/SubagentAwait/Task 四件/AskUser）；可压缩自己的工作历史但 `persistMacro=false`，不碰根 Session 的 Macro 边界。
- `loop/turnBudget.ts` 的 `TurnBudget` 是根与全部子 Agent 共用的 AgentBudget 实现（时长/输出/工具/子 Agent 额度）。

## 事件

`turn/events.ts` 只拥有 Turn 自有生命周期事件；`TurnStreamEvent` 是流组合（TurnEvent | TurnAgentRunEvent | ToolExecutionEvent | permission 两事件 | CompactEvent），各域事件由拥有方定义。AgentRun 事件入流时由工具层补上 sessionId/turnId（agent 包不感知根身份）。

## 目录

```text
src/turn/
├─ index.ts                 公共出口（含 turn-terms 表面组合）
├─ types.ts                 StartTurn / TurnOutcome / TurnHandle
├─ events.ts                TurnEvent / TurnStreamEvent / TurnAgentRunEvent
├─ errors.ts                TurnOwnership/ActiveTurn/TurnPreparation/TurnBudgetExceeded + failureCodeOf/failureMessageOf
├─ turn.ts                  TurnExecutor：唯一公开入口 + 主循环驱动
├─ turnStore.ts             Turn 行 CRUD + 唯一终态 + 运行态/删除守卫 + 导航查询
├─ activeTurnRegistry.ts    同 Session 一个活动 Turn
├─ eventChannel.ts          TurnEvent 单消费者有界通道
├─ interactionQueue.ts      SessionInteractionQueue（Permission/AskUser 共用的 Session FIFO）
├─ preparation/             Turn 启动一次性冻结
│  ├─ prepareTurn.ts        输入规范化与冻结编排
│  ├─ prepareTurnTools.ts   工具层装配 + 权限/问询口子
│  └─ mediaCompatibility.ts 原始图片块能力降级
├─ loop/                    运行期内部件
│  ├─ prepareLlmCall.ts     PrepareAgentIteration 实现（assemble→compact→再 assemble）
│  ├─ turnMessageWriter.ts  事件驱动流式落库
│  ├─ prepareSubagent.ts    子 Agent AgentLoopInput 工厂
│  └─ turnBudget.ts         AgentBudget 本包实现
└─ tests/
```

## 依赖方向

```text
turn ──> session / agent / context / compact / prompts / providers / skills / tools
       / permission / attachments / characters / narrative / knowledge / sandbox / settings
       / tasks / git / llm / storage / turn-terms
```

- 不实现任何 Provider、Tool、Memory、Narrative、Speech 或 HTTP 协议；Route 只拿 `TurnExecutor`，不接触内部件。
- Memory 零 import：recall 经 `reminderSources.memoryRecall` 注入槽进入 ContextReminder；Sol 拆包后由 Server 接线。
- 旧 `src/turnExecution` 已物理删除；不存在 RootAgentExecution 或任何第三层执行器。
