# Turn

`src/turn` 拥有一次完整交互：建立 Turn 身份、冻结本轮一切可变事实、运行唯一一个根 AgentLoop、按事件顺序持续落库，并提交唯一终态。

公开入口只有 `turn.ts` 的 `TurnExecutor`；领域词汇本包自持（`types.ts` 的 Turn/TurnStats/TurnFailureCode 等），共享词汇 ExecutionProfile/NarrativePolicy/TurnStatus 来自 `@ema-agent/session`。

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
- `StartTurn.input` 是唯一有序输入：`text / attachment / skill` 按数组位置持久化、投影给模型并用于历史展示。模型覆盖收进 `modelSelection`；`knowledge.assetIds` 只约束当前激活知识库内的文档范围。Command/Skill 解析在调用方完成，Turn 不解析 `/` 语法，也不接受 prepare 回调。
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
  │    ├─ 附件登记（AttachmentStore.addAll）→ 用户消息只保存 attachment_ref
  │    ├─ Skill：work 态 freezeSkillPool + 选中引用冻结；正文由 Skill Tool 按需读取
  │    ├─ 权限三桶 loadPermissionRuleBuckets
  │    └─ prepareTurnTools：ToolUseContext + 根 ToolPool + askPermission/askUser 口子
  │        → getSystemPrompt（扁平数组，含工具名投影）
  ├─ setModel 回填 Turn 行
  ├─ readTurnReminder（每根 Turn 一次：currentDate、git 仅 work、Memory 两轨摘要、
  │    Narrative always 一次召回、Task take 一次性提醒、scratchpad 快照）→ renderTurnReminder
  │    → 落 kind='reminder' 消息（先于用户消息）
  ├─ 写 initial user Message（text / attachment_ref / skill_ref 保持输入顺序）
  ├─ loadHistory 按 reminder 行切分：之前 = 可压缩历史区间；reminder + 当前用户消息
  │    = 当前 Turn 区间；两段统一经 deriveLlmHistory 投影附件与 Skill 引用
  └─ runAgentLoop（唯一一个根循环）
       ├─ prepareLlmCall（loop/，每次模型调用前）
       │    ├─ 基线切分：history（唯一可压缩区间）+ currentTurn
       │    ├─ assembleContext → 未超直接返回
       │    └─ 超限 compact：micro 直接重装配；macro 落 kind='summary' 消息（turnId=null，
       │       摘要即覆盖游标）再重装配；返回可能被改写的整体工作历史
       ├─ TurnMessageWriter 流式落库
       └─ 事件翻译 → TurnStreamEvent 通道
  → finishSafely：writer 收口（interrupted + 孤儿 tool_use 合成）→ 交互队列清理
    → 工具与子 Agent shutdown → 活跃执行坑位释放（ActiveSessionRegistry，归 session 包）
  → TurnStore 一次终态：completed / failed / aborted
```

## 持久化不变量

- **yield 恢复 = 已保存**：`tool_use_completed` 落库后 AgentLoop 才登记调用；`assistant_message_completed` 落库后才允许 `executor.start()`；`tool_result` 落库后才 `acknowledgeResult()`。
- 模型选择与实际调用协议在 prepare 解析成功后一次回填：`setModel(turnId, providerId, modelId, protocol)` 是唯一回填点，turns 行冻结三字段后不再从 Provider 配置事后反推。
- 首个 delta 创建 assistant 消息，后续 delta 用 `updateMessageBlocks` 续写同一消息。
- 终态非 completed 时未完成 assistant 标 `interrupted`；`max_tokens` 从头重试也先把被替代的半截消息标记为 `interrupted`。未等到 tool_result 的 tool_use 由 Turn 合成取消结果补配对；deriveLlmHistory 不重放中断 Assistant 或不完整 Tool 配对。
- 先落库，再发事件：SSE 不是持久化触发器。

## 权限与交互

- 权限判定上下文（模式 + 三桶规则）Turn 冻结；settings 源次 Turn 生效，session 源本 Turn 即效。
- 根 Turn 始终 interactive：`askPermission` 口子 = permission_required/resolved 事件 + interactionQueue 等回答 + `allowSession` 经 `applyPermissionUpdate` 沉淀 session 规则（`ruleSuggestion` 来自 Tool 的 ask 决策）。
- 子 Agent headless：`createSubagentExecutor` 不提供 askPermission 口子，中央把 ask 收口为 deny。
- Permission 与 AskUser 统一 toolCallId 锚，共用 `interactionQueue.ts` 的 Session FIFO（跨 Session 并行，Turn 终态统一取消）。

## 子 Agent

- `loop/prepareSubagent.ts`：clean 上下文或 fork 继承；`parentMessages` 只保存父 Agent 当前工作消息，不含根 System Prompt、Tool Schema 或缓存标记。ToolPool 只从父 Pool 收窄（disallowedTools + 内建拒绝：Subagent/SubagentAwait/Task 四件/AskUser）；每个子 Agent 拥有独立 Compact 状态且没有 `macroPersistence`，不碰根 Session 的 Macro 边界。
- `loop/turnBudget.ts` 的 `TurnBudget` 是根与全部子 Agent 共用的 AgentBudget 实现（时长/输出/工具/子 Agent 额度）。

## 事件

`turn/events.ts` 只拥有 Turn 自有生命周期事件；`TurnStreamEvent` 是流组合（TurnEvent | TurnAgentRunEvent | ToolExecutionEvent | permission 两事件 | CompactEvent | NarrativeEvent），各域事件由拥有方定义。AgentRun 事件入流时由工具层补上 sessionId/turnId（agent 包不感知根身份）。

Reminder 表示"本 Turn 开始时的事实"：TurnExecutor 每根 Turn 调一次 `readTurnReminder`（`TurnReminderScope`：sessionId/turnId/executionProfile/narrativePolicy/userText/emit）取回完整启动期输入（含 currentDate），`renderTurnReminder` 渲染后经 `appendMessage(kind='reminder')` 持久化，再由 loadHistory 读回放进当前 Turn 工作消息——同一份字节，不随 LLM Call 重建，也不进可压缩区间。Narrative 三态：always 在取输入时查询一次写入 reminder；auto 只装配 NarrativeSearchTool；off 两者皆无。

## 目录

```text
src/turn/
├─ index.ts                 公共出口（含本包类型与事件）
├─ types.ts                 StartTurn / TurnOutcome / TurnHandle
├─ events.ts                TurnEvent / TurnStreamEvent / TurnAgentRunEvent
├─ errors.ts                TurnOwnership/TurnPreparation/TurnBudgetExceeded + failureCodeOf/failureMessageOf
├─ turn.ts                  TurnExecutor：唯一公开入口 + 主循环驱动
├─ turnStore.ts             Turn 行 CRUD + 唯一终态 + 运行态/删除守卫 + 导航查询
│                           （Session 活跃执行坑位 = session 包 ActiveSessionRegistry）
├─ eventChannel.ts          TurnEvent 单消费者有界通道
├─ interactionQueue.ts      SessionInteractionQueue（Permission/AskUser 共用的 Session FIFO）
├─ settings.ts              workspace.instructionFiles（用户多选工作区指令文件，nextTurn 生效）
├─ preparation/             Turn 启动一次性冻结
│  ├─ prepareTurn.ts        StartTurn 请求 + 已创建 turnId 的一次性冻结编排
│  ├─ prepareTurnTools.ts   工具层装配 + 权限/问询口子
│  └─ turnReminder.ts       本 Turn 初始背景消息（kind='reminder'）的唯一文本构建
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
       / tasks / git / llm / storage
```

- 不实现任何 Provider、Tool、Memory、Narrative、Speech 或 HTTP 协议；Route 只拿 `TurnExecutor`，不接触内部件。
- Memory 零 import：两轨摘要与使用指引文本经 `readTurnReminder` / `memoryGuidance` 注入闭包由 Server 装配。
- 旧 `src/turnExecution` 已物理删除；不存在 RootAgentExecution 或任何第三层执行器。
