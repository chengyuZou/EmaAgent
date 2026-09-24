# Turn

Turn 管一次根 Agent 对话：创建运行记录，准备模型和工具，写入消息，驱动 AgentLoop，最后写入 completed、failed 或 aborted。HTTP Route 不负责这些步骤，只调用 `TurnExecutor`。

## 对外接口

`TurnExecutor` 提供 `start`、`abort`、`abortAndAwait`、`abortTool` 和 `abortSubagent`。`start` 立即返回 `TurnHandle`；调用方从 `events` 读取过程事件，从 `completion` 等最终结果。`StartTurn.input` 是有序的文本、附件和 Skill 引用，Turn 保持这个顺序入库。模型和推理强度从 Session 读取，并在本轮准备时确定。

## 一轮怎样运行

1. `TurnStore.startTurn` 创建运行中的 Turn，同一 Session 不同时运行两根 Turn。
2. `prepare/prepareTurn.ts` 读取 Session、设置和模型事实，处理输入附件与 Skill，准备工具和 System Prompt，返回本轮固定使用的 `PreparedTurn`。`prepare/prepareTurnTools.ts` 管工具池、权限询问和 AskUser 的执行入口。
3. Turn 读取一次 reminder，先写 reminder，再写用户输入或后台完成通知。之后调用 `SessionStore.loadHistory`，由 Context 的 `projectSessionMessages` 把有效 SQL 消息投影为模型消息。这里不再切 `history/currentTurn`。
4. 每次模型调用前，`prepare/prepareAgentIteration.ts` 用完整模型消息数组装配 Context，并把同一数组交给 Compact。Micro 改写消息内容；Macro 用摘要替换被覆盖的前缀，摘要作为 `kind='summary'` 的 Session Message 落库。System Prompt 只参加本次请求，不写入 Session Message，也不参加工作消息压缩。
5. `AgentLoop` 产出流式事件。`turnMessageWriter.ts` 在首个 Assistant 增量时建行，后续更新同一行；`tool_use_completed` 先保存调用，AgentLoop 恢复后才启动工具；每个 `tool_result` 保存为独立 User Message。Turn 再把事件转发给前端。
6. 完成时写入唯一终态，收口未完成的 Assistant 和工具调用，关闭交互队列与事件通道；队列决定是否启动下一根 Turn。

## Macro 与消息 ID

Compact 只认识模型消息数组和 `summarizedMessageCount`，不知道 SQL ID。Turn 同步保留一个同长度的 SQL ID 数组。最初的 ID 来自 `projectSessionMessages`；之后完整 Assistant、ToolResult 和追加的用户输入落库时，把新 ID 按 AgentLoop 的 `model_history_appended` 顺序补进去。

续写提示和 stuck guide 当前仅存在于 AgentLoop 的模型消息里，没有 SQL 行；它们在 ID 数组中占 `undefined`。Macro 保存时取被覆盖前缀最后一个有 SQL 身份的消息作 `summarizedThroughMessageId`，不能拿“第 N 条 SQL 消息”推断。保存成功后，前缀的 ID 一起替换成新 Summary 的 ID。再次压缩若覆盖了这个 Summary，Storage 会沿 Summary 游标向前追到原始覆盖边界；重放时只放最新 Summary 和未覆盖的普通消息。

这套对应关系是 Turn 内部运行状态，不向 Context、Compact 或 AgentLoop 增加 SQL 字段。模型专用引导目前没有落盘；如果以后要使它在重启后继续存在，需要单独改变 AgentLoop 的事件和 Session 写入流程。

## 子 Agent

`prepare/prepareSubagent.ts` 为子 Agent 选择模型、System Prompt、工具子集和独立的 Compact 闭包。子 Agent 不提供根 Session 的 `macroPersistence`，因此其摘要只改自己的模型消息。当前 fork 只复制父 Agent 已准备的消息；完整继承父 System Prompt、模型可见工具、Thinking，以及补齐尚未闭合的父 ToolUse，仍属于后续 fork 改造，不能把当前实现当成完整 fork。

## 文件位置

```text
src/turn/
  turn.ts                    根 Turn 编排与唯一公开执行入口
  turnMessageWriter.ts       AgentLoop 事件到 Session Message 的写入
  turnStore.ts               Turn 行与运行状态
  eventChannel.ts            单消费者过程事件通道
  interactionQueue.ts        Permission 和 AskUser 等待队列
  sessionContinuationQueue.ts 追加输入与后台完成通知队列
  prepare/
    prepareTurn.ts           一次性准备根 Turn
    prepareTurnTools.ts      工具池及工具执行入口
    prepareAgentIteration.ts 每次模型调用前装配与压缩
    prepareSubagent.ts       子 Agent 调用准备
    sessionSystemPrompt.ts   System Prompt 装配
    turnReminder.ts          reminder 内容生成
  tests/
```

`types.ts`、`events.ts`、`errors.ts` 和 `index.ts` 分别定义公开词汇、事件、错误与包出口。测试只通过公开入口和真实消息读取验证行为，不为了测试暴露内部装配对象。
