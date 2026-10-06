# Turn

Turn 管一次根 Agent 对话：创建运行记录，准备模型和工具，写入消息，驱动 AgentLoop，最后写入 completed、failed 或 aborted。HTTP Route 不负责这些步骤，只调用 `TurnExecutor`。

## 对外接口

`TurnExecutor` 提供 `start`、`abort`、`abortAndAwait`、`abortTool` 和 `abortSubagent`。`start` 立即返回 `TurnHandle`；调用方从 `events` 读取过程事件，从 `completion` 等最终结果。`StartTurn.input` 是有序的文本、附件和 Skill 引用，Turn 保持这个顺序入库。模型和推理强度从 Session 读取，并在本轮准备时确定。

## 一轮怎样运行

1. `TurnStore.startTurn` 创建运行中的 Turn，同一 Session 不同时运行两根 Turn。
2. `prepare/prepareTurn.ts` 读取 Session、设置和模型事实，处理输入附件与 Skill，准备工具和 System Prompt，返回本轮固定使用的 `PreparedTurn`。`prepare/prepareTurnTools.ts` 管工具池、权限询问和 AskUser 的执行入口。
3. Turn 读取一次 reminder, 先写 reminder, 再分别写 `continuationText` 内部续接文本与用户输入. 二者可以在同一 Turn 中同时存在; 前者持久化为 `kind='continuation'`, 不发用户发言事件. 之后调用 `SessionStore.loadHistory`, 由 Context 的 `projectMessages` 把有效 SQL 消息投影为模型消息. 这里不再切 `history/currentTurn`.
4. 每次模型调用前，`prepare/prepareAgentIteration.ts` 用完整模型消息数组装配 Context，并把同一数组交给 Compact。Micro 改写消息内容；Macro 用摘要替换被覆盖的前缀，摘要作为 `kind='summary'` 的 Session Message 落库。System Prompt 只参加本次请求，不写入 Session Message，也不参加工作消息压缩。
5. `AgentLoop` 产出流式事件。`turnMessageWriter.ts` 在首个 Assistant 增量时建行，后续更新同一行；`tool_use_completed` 先保存调用，AgentLoop 恢复后才启动工具；每个 `tool_result` 保存为独立 User Message。写入完成后, `turnLoopEvents.ts` 再把根循环事件转成前端事件, 更新 Context 用量并记录物理 LLM 调用用量. 子代理调用只复用记账入口, 不改根 Context 用量.
6. 写入唯一终态后, 收口未完成的 Assistant 和工具调用, 关闭交互与工具, 按停止/失败策略暂停本轮 Goal, 再清除运行占用并通知队列. `completion` 和终态事件在执行收尾与解锁之后交付, 不让消费方接到半收尾的 Session.

## Session 续接与 Goal

Permission 与 AskUser required/resolved 独立于根 Turn 事件流, 由宿主的 publishInteraction 直接交付 Session.
根与前后台子工具共用 SessionInteractionQueue; 根收尾的 cancelForTurn 只清自己的
Permission/AskUser, 不清携带同一父 turnId 的子请求. 子执行统一收尾通过 onRunFinished
调用 cancelForRun, Session 删除使用 cancelForSession. 队列按需创建并在空时释放,
不检查 Goal、后台进程或 Session 是否完全空闲. Desktop 按 Session 出口消费交互事实,
初始 pendingInteractions 保持服务端顺序, 后续按交付顺序追加/移除; 不用浏览器时钟重排.
Permission 回答仅携带 SessionId 和 ToolCallId, 由队首原请求取得所属 Turn/Run.
AskUser 回答保留其 turnId, 但展示和队首约束同样来自 Session FIFO.

`SessionContinuationQueue` 是唯一交付入口. `SessionRunningRegistry` 判断根 Turn 或手动 Compact 的占用; 同一 Session 的多个唤醒合并成一次微任务, 领取和注册之间不 await.

- 下一根 Turn 先领取用户输入, 当前 Goal active 则同时附带短 continuationText. Turn 将提示与正常用户 Message 分别落库, 不互相替换, 不额外启动第二根 Turn. 没有用户输入时保留后台通知顺序, 没有一次性内容时生成纯 Goal 继续指令. 只有一个 `startTurn` 路径, Goal 不永久入队或复制正文.
- `claimNextIteration` 交付绑定当前根 Turn 的目标正文编辑, 后台完成通知和用户立即引导, 不生成持续 Goal 续接. 普通排队输入和持续 Goal 留到 Turn 收尾后处理. 完整 Assistant 与本批 ToolResult 保存后才领取, 无工具的正文回复也检查.
- 后台通知与 Goal 续接对 Turn 都是 `type='continuation'` / `continuationText`. Subagent 和后台 Process 的通知仍在队列内部保留执行 ID, 去重键和 claim/acknowledge/release 身份. 模型用 `SubagentAwait` 或 `ProcessOutput` 读取完整结果.
- 一次性输入/通知在对应 Message 持久化后才 acknowledge, 准备或写入失败则 release. 停止和最终失败向同一 `turnFinished` 入口交付事实, 但不立即重试归还内容; 后续用户入队, Goal 激活或后台完成等明确唤醒仍可交付.
- Goal 创建/激活事件请求同一队列排水. Session 忙碌时不抢占, 正常 Turn 收尾和手动 Compact 的 finally 解锁后重新选择最新工作. Server 关闭先 shutdown 队列, Session 删除由既有 TurnStore 删除守卫挡住新启动.
- 新 Turn 的 reminder 交付 Goal 身份, version, objective 和 feedback. `goal_edited` 在根 Turn 运行且 Goal active 时标记待交付编辑, 安全点从 SQL 读取最新正文并持久化为隐藏 continuation Message, 不改写初始 reminder 或发用户气泡. 同一安全点前的多次编辑合并为最新事实, feedback 的 `goal_updated` 不生成编辑消息. 空闲, 手动 Compact 或 paused 时编辑只保存, 不启动模型; 未交付编辑在所属 Turn 收尾时清除, 下一 Turn 仍读取新 reminder.
- 当前 Turn 中关闭 Goal 不直接 abort; Store 拒绝旧版本完成或进度写入, 收尾后不再生成已关闭目标的续接. 不引入第二套 AgentLoop.
- 当前根 Turn 实际处理的同一个 Goal 仍 active 时, `max_iterations` 表示单 Turn 工作配额已用完: 工具结果完整保存后按 completed 收尾, 解锁后由同一队列选择下一 Turn. completed 只表示这根 Turn 已结束, 不代表 Goal 成功. 无 Goal 和子代理仍保留原有上限处理. 队列仍优先交付已排队的用户输入, 不绕过用户停止, 真正失败或应用关闭.
- 用户停止或最终运行失败时, 暂停本轮处理的同一个 GoalId 的当前 active 版本. feedback, 编辑或重新激活增加版本也不漏暂停; 不改写已经关闭的 Goal 或后来新建的另一个 Goal. 模型已结束但工具仍在收尾时收到停止信号, 也会暂停该 Goal 并停止自动续接, 不重写已提交的 Turn 终态.

Goal 总 Token 预算和跨 Turn 空转判定尚未实现. 单 Turn 配额不会限制整个 Goal 的累计调用量; 预算的存储, 物理调用记账和自动续接准入位置各留有具体 TODO.

## Macro 与消息 ID

Compact 只认识模型消息数组和 `summarizedMessageCount`，不知道 SQL ID。Turn 同步保留一个同长度的 SQL ID 数组。最初的 ID 来自 `projectMessages`；之后完整 Assistant、ToolResult 和追加的用户输入落库时，把新 ID 按 AgentLoop 的 `model_history_appended` 顺序补进去。

续写提示和 stuck guide 当前仅存在于 AgentLoop 的模型消息里，没有 SQL 行；它们在 ID 数组中占 `undefined`。Macro 保存时取被覆盖前缀最后一个有 SQL 身份的消息作 `summarizedThroughMessageId`，不能拿“第 N 条 SQL 消息”推断。保存成功后，前缀的 ID 一起替换成新 Summary 的 ID。再次压缩若覆盖了这个 Summary，Storage 会沿 Summary 游标向前追到原始覆盖边界；重放时只放最新 Summary 和未覆盖的普通消息。

这套对应关系是 Turn 内部运行状态，不向 Context、Compact 或 AgentLoop 增加 SQL 字段。模型专用引导目前没有落盘；如果以后要使它在重启后继续存在，需要单独改变 AgentLoop 的事件和 Session 写入流程。

## Plan 权限

`session.permissionMode = 'plan'` 在准备阶段收窄本轮 ToolPool, System Prompt 同时声明只读调查与规划约束.
模型与执行器共用筛选后的池, 显式 allow 规则不会扩入已排除的工具. Chat/Work 不变,
没有 Plan 进入/退出工具和确认状态. 权限在 Turn 开始时冻结, 菜单切换只影响下一根 Turn.
只读池保留检索与读取, 包括 Task/Scratchpad 读取; 不包含 Shell, 写入, Subagent, AskUser 或 MCP.

## 子 Agent

每根 Turn 的 reminder 包含当前 Session 的子代理身份目录. Server 在异步背景读取结束后沿身份 Cursor 读完所有页, 按 updatedAt 降序、同时间 ID 降序交付. 前 10 个展示 ID、完整 Title 和 description 前 50 个 Unicode 字符, 其余全部只展示 ID; 没有目录总条数或总内容长度截断. 空目录不生成该段, SQL 正文不改写. 目录随本轮 reminder 落库, 后续模型请求复用, 不每个 loop 回查或读取 Run/子消息. 主模型的子代理详情查询工具尚未接入.

`forkParentMessages.ts` 持有每次父请求固定的模型消息与 ID 对应关系. `beginRequest` 只复制两个数组, 不读取 SQL; `completeAssistant` 在父 Assistant 完整落库后只交付其 ID 和生成来源. 真实新建 fork 才调用 `read`: 绑定所属请求, 等完整 Assistant 后读取持久化信息并构建父前缀. 同一父请求的兄弟 fork 共用一次构建, 没有领取者就不回查 SQL. 等待取消只影响对应子代理, 父失败释放等待者. 它不写子代理消息表, 复制和新 ID 映射仍由 Agent 消息层负责.

`prepare/prepareSubagent.ts` 为子 Agent 选择模型, System Prompt, 工具子集和独立的 Compact 闭包. 它调用 Agent 的 `messageStore` 初始化/读取子代理历史, 复用根循环的消息投影与 Compact 准备; Macro 通过各自的 `appendSummary` 回调写到子代理消息表, 不写根 Session.

新建 fork 在发起它的父 Assistant 完整落库后, 领取本次父请求固定前缀与这条完整 Assistant; 消息 ID、摘要字段和生成来源一起交给 Agent 消息层复制. 分叉后不继续接收父消息. 当前 Assistant 的工具调用在子代理副本中补统一占位结果, 不等待父工具完成, 不把占位写回父 Session. 子任务和子代理边界 reminder 分别作为 User Message. 继续旧 ID 不再领取父前缀. Role 及其 System/工具排除覆盖参数已移除, 工具池仍按统一子代理规则收窄.

Prompt 包提供 `staticSystemPrompt` 数组和 `getDynamicSystemPrompt(input)`. 根 Turn 直接准备输入并拼接, `PreparedTurn.DynamicSystemPromptInput` 保存本轮动态输入, 不再经过完整 System 装配包装函数. 手动 Compact 使用同一数组和动态函数.

普通、fork 和继续旧子代理共用纯工作 System: 复用静态规则与父调用已经读取的工作区/Memory/Skill/MCP 文本, 不传角色和 SessionMode, 按实际子模型与子 ToolPool 生成环境和能力说明, 最后追加 `subagent` 块. 该块说明委派范围、验证、向父交付、不接管父 Goal 与后台任务交接. 普通子代理不等待父 Assistant; fork 仍按原有顺序等待完整父前缀. 未完成后台命令交付 `backgroundProcessId`, 用途和最后已知状态, 由父 Agent 使用 `ProcessOutput` 接手. 等待分叉输入时的子代理取消, 父模型失败或父消息保存失败, 都会结束等待.

## 文件位置

```text
src/turn/
  turn.ts                    根 Turn 编排与唯一公开执行入口
  forkParentMessages.ts      固定父请求前缀, 等完整 Assistant 落库后交付 fork
  turnLoopEvents.ts          根事件投影, Context 用量与根/子 LLM 调用记账
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
    skillPool.ts             根 Turn 与 Compact 共用的 SkillPool 准备
    turnReminder.ts          reminder 内容生成
  tests/
```

`types.ts`、`events.ts`、`errors.ts` 和 `index.ts` 分别定义公开词汇、事件、错误与包出口。执行链集成测试通过公开入口和真实消息读取验证行为; fork 交接与事件投影另有模块测试. 这两个模块只供 Turn 内部使用, 不增加包出口.
