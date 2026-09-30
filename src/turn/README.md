# Turn

Turn 管一次根 Agent 对话：创建运行记录，准备模型和工具，写入消息，驱动 AgentLoop，最后写入 completed、failed 或 aborted。HTTP Route 不负责这些步骤，只调用 `TurnExecutor`。

## 对外接口

`TurnExecutor` 提供 `start`、`abort`、`abortAndAwait`、`abortTool` 和 `abortSubagent`。`start` 立即返回 `TurnHandle`；调用方从 `events` 读取过程事件，从 `completion` 等最终结果。`StartTurn.input` 是有序的文本、附件和 Skill 引用，Turn 保持这个顺序入库。模型和推理强度从 Session 读取，并在本轮准备时确定。

## 一轮怎样运行

1. `TurnStore.startTurn` 创建运行中的 Turn，同一 Session 不同时运行两根 Turn。
2. `prepare/prepareTurn.ts` 读取 Session、设置和模型事实，处理输入附件与 Skill，准备工具和 System Prompt，返回本轮固定使用的 `PreparedTurn`。`prepare/prepareTurnTools.ts` 管工具池、权限询问和 AskUser 的执行入口。
3. Turn 读取一次 reminder, 先写 reminder, 再分别写 `continuationText` 内部续接文本与用户输入. 二者可以在同一 Turn 中同时存在; 前者持久化为 `kind='continuation'`, 不发用户发言事件. 之后调用 `SessionStore.loadHistory`, 由 Context 的 `projectSessionMessages` 把有效 SQL 消息投影为模型消息. 这里不再切 `history/currentTurn`.
4. 每次模型调用前，`prepare/prepareAgentIteration.ts` 用完整模型消息数组装配 Context，并把同一数组交给 Compact。Micro 改写消息内容；Macro 用摘要替换被覆盖的前缀，摘要作为 `kind='summary'` 的 Session Message 落库。System Prompt 只参加本次请求，不写入 Session Message，也不参加工作消息压缩。
5. `AgentLoop` 产出流式事件。`turnMessageWriter.ts` 在首个 Assistant 增量时建行，后续更新同一行；`tool_use_completed` 先保存调用，AgentLoop 恢复后才启动工具；每个 `tool_result` 保存为独立 User Message。Turn 再把事件转发给前端。
6. 写入唯一终态后, 收口未完成的 Assistant 和工具调用, 关闭交互与工具, 按停止/失败策略暂停本轮 Goal, 再清除运行占用并通知队列. `completion` 和终态事件在执行收尾与解锁之后交付, 不让消费方接到半收尾的 Session.

## Session 续接与 Goal

`SessionContinuationQueue` 是唯一交付入口. `SessionRunningRegistry` 判断根 Turn 或手动 Compact 的占用; 同一 Session 的多个唤醒合并成一次微任务, 领取和注册之间不 await.

- 下一根 Turn 先领取用户输入, 当前 Goal active 则同时附带短 continuationText. Turn 将提示与正常用户 Message 分别落库, 不互相替换, 不额外启动第二根 Turn. 没有用户输入时保留后台通知顺序, 没有一次性内容时生成纯 Goal 继续指令. 只有一个 `startTurn` 路径, Goal 不永久入队或复制正文.
- `claimNextIteration` 仍只交付后台完成通知和用户立即引导, 不生成 Goal 续接. 普通排队输入和 Goal 留到 Turn 收尾后处理.
- 后台通知与 Goal 续接对 Turn 都是 `type='continuation'` / `continuationText`. Subagent 和后台 Process 的通知仍在队列内部保留执行 ID, 去重键和 claim/acknowledge/release 身份. 模型用 `SubagentAwait` 或 `ProcessOutput` 读取完整结果.
- 一次性输入/通知在对应 Message 持久化后才 acknowledge, 准备或写入失败则 release. 停止和最终失败向同一 `turnFinished` 入口交付事实, 但不立即重试归还内容; 后续用户入队, Goal 激活或后台完成等明确唤醒仍可交付.
- Goal 创建/激活事件请求同一队列排水. Session 忙碌时不抢占, 正常 Turn 收尾和手动 Compact 的 finally 解锁后重新选择最新工作. Server 关闭先 shutdown 队列, Session 删除由既有 TurnStore 删除守卫挡住新启动.
- 新 Turn 的 reminder 交付 Goal 身份, version, objective 和 feedback. 当前 Turn 中关闭 Goal 不直接 abort; Store 拒绝旧工具写入, 收尾后不再生成已关闭目标的续接. 不增加每次模型请求的目标替换协调或第二套 AgentLoop.
- 用户停止或最终运行失败时, 暂停本轮处理的同一个 GoalId 的当前 active 版本. feedback, 编辑或重新激活增加版本也不漏暂停; 不改写已经关闭的 Goal 或后来新建的另一个 Goal. 模型已结束但工具仍在收尾时收到停止信号, 也会暂停该 Goal 并停止自动续接, 不重写已提交的 Turn 终态.

## Macro 与消息 ID

Compact 只认识模型消息数组和 `summarizedMessageCount`，不知道 SQL ID。Turn 同步保留一个同长度的 SQL ID 数组。最初的 ID 来自 `projectSessionMessages`；之后完整 Assistant、ToolResult 和追加的用户输入落库时，把新 ID 按 AgentLoop 的 `model_history_appended` 顺序补进去。

续写提示和 stuck guide 当前仅存在于 AgentLoop 的模型消息里，没有 SQL 行；它们在 ID 数组中占 `undefined`。Macro 保存时取被覆盖前缀最后一个有 SQL 身份的消息作 `summarizedThroughMessageId`，不能拿“第 N 条 SQL 消息”推断。保存成功后，前缀的 ID 一起替换成新 Summary 的 ID。再次压缩若覆盖了这个 Summary，Storage 会沿 Summary 游标向前追到原始覆盖边界；重放时只放最新 Summary 和未覆盖的普通消息。

这套对应关系是 Turn 内部运行状态，不向 Context、Compact 或 AgentLoop 增加 SQL 字段。模型专用引导目前没有落盘；如果以后要使它在重启后继续存在，需要单独改变 AgentLoop 的事件和 Session 写入流程。

## Plan 权限

`session.permissionMode = 'plan'` 在准备阶段收窄本轮 ToolPool, System Prompt 同时声明只读调查与规划约束.
模型与执行器共用筛选后的池, 显式 allow 规则不会扩入已排除的工具. Chat/Work 不变,
没有 Plan 进入/退出工具和确认状态. 权限在 Turn 开始时冻结, 菜单切换只影响下一根 Turn.
只读池保留检索与读取, 包括 Task/Scratchpad 读取; 不包含 Shell, 写入, Subagent, AskUser 或 MCP.

## 子 Agent

`prepare/prepareSubagent.ts` 为子 Agent 选择模型, System Prompt, 工具子集和独立的 Compact 闭包. 子 Agent 不提供根 Session 的 `macroPersistence`, 因此其摘要只改自己的模型消息.

fork 在发起它的父 Assistant 完整落库后, 领取本次父请求准备好的工作历史与这条完整 Assistant. 分叉后不继续接收父消息. 当前 Assistant 的工具调用在子代理输入副本中补统一的占位结果, 不等待父工具完成, 也不把占位写回父 Session. fork 继承父 System Prompt 与默认模型/Thinking 配置, 子角色约束和具体任务追加在最后的 User 指令中. 工具池仍按既有子代理规则收窄, 尚未实现父子完全相同的工具定义.

普通子代理仍以独立角色提示词和任务开始, 不等待父 Assistant. 两种子代理都被要求在交差时说明未完成后台命令的 `backgroundProcessId`, 用途和最后已知状态, 由父 Agent 使用 `ProcessOutput` 接手. 等待分叉输入时的子代理取消, 父模型失败或父消息保存失败, 都会结束等待, 不启动缺少完整父上下文的子模型请求.

## 文件位置

```text
src/turn/
  turn.ts                    根 Turn 编排与唯一公开执行入口
  turnMessageWriter.ts       AgentLoop 事件到 Session Message 的写入
  turnStore.ts               Turn 行与运行状态
  eventChannel.ts            单消费者过程事件通道
  interactionQueue.ts        Permission 和 AskUser 等待队列
  sessionContinuationQueue.ts 追加输入, 后台通知与 Goal 的统一续接队列
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
