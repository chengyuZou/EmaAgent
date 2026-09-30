# Goal

`@ema-agent/goal` 负责 Session 目标的持久业务规则. GoalStore 导入 Storage 并在本包内映射行, SQL 和 Row 类型留在 Storage, 不装饰 CallLlm 或实现另一套 AgentLoop.

## 已实现的领域事实

- 一个 Session 可以保留多个历史 Goal, active 和 paused 合起来最多一条. SQL 部分唯一索引约束这一关系, Session 删除通过外键级联清理目标.
- 新建目标立即 active. 状态只有 `active | paused | completed`; completed 的 reason 为 `succeeded | failed | cancelled`, 只有 failed 保存 error.
- active 允许报告完成或最终失败. paused 必须由用户明确激活后才允许继续推进. 取消可以关闭 active 或 paused, 保留 completed/cancelled 历史, 不伪装成错误.
- 已完成目标不能编辑或重新激活. 重新建立目标必须获得新的 ID.
- `feedback` 是工作模型最近一次累计进度概况, 初始为 null, 只保存最新文本, 不追加历史. 不代表目标完成, 也不授权激活. active 可报告进度, 完成或最终失败时必须同时更新收尾概况; 全部成果的详细总结由 Turn 最终回复给出. 用户编辑正文后清空旧反馈, 暂停或取消保留最后反馈供查询展示.
- 每次实际修改递增 version 并更新时间. 同正文编辑、已经 paused 时再暂停和已经 active 时再激活均不重复写入或发事件, 但仍必须匹配当前版本.
- 正文字段统一为 `objective`. 创建和编辑只检查非空白, 保存原文, 不 trim 或规范化空格与换行.

## GoalStore 接口

构造函数为 `new GoalStore(dataDb, emit?)`. Repo 由 Store 自己构造, Server 装配唯一 Store 实例. `emit` 接收 SQL 提交后的 GoalEvent, 不负责调用模型.

| 方法 | 职责 |
| --- | --- |
| `create(sessionId, objective)` | 建立新 active 目标, 拒绝 Plan 或已有未关闭目标. |
| `get(sessionId, goalId)` | 按 Session 和 Goal 身份读取, 不存在返回 null. |
| `getCurrent(sessionId)` | 读取 active/paused 目标, 没有则返回 null. |
| `listSummaries(sessionId)` | 按创建时间倒序读取 GoalSummary 历史列表行, 不读取反馈或失败详情. |
| `edit(identity, objective)` | 编辑未关闭目标正文. |
| `reportFeedback(identity, feedback)` | 仅报告 active 目标的最新进度, 不改变状态. |
| `pause(identity)` / `activate(identity)` | 暂停或由用户激活未关闭目标. |
| `complete(identity, feedback)` / `fail(identity, feedback, error)` | 一次写入新的收尾概况和成功/最终失败状态, 不是普通工具错误. |
| `cancel(identity)` | 关闭并保留 cancelled 历史. |
| `delete(identity)` | 物理删除明确目标. |
| `pauseActiveOnStartup()` | ready 前将旧 active 转 paused, 保留 ID, 递增版本; 不启动工作. |

修改与删除的 identity 明确包含 `sessionId`, `goalId`, `expectedVersion`. 身份读取、版本和状态检查、写入处于同一个同步 SQLite 写事务, 中间不 await. 失败抛出 GoalError, `code` 表达原因, `current` 提供可读取事实. 不存在、状态或版本冲突都不隐式新建、恢复或改写后继目标.

Plan 的双向互斥分别由 GoalStore 新建/激活和 SessionStore 的 Permission 修改事务实现. active/paused 都挡住切 Plan, 完成或删除才释放互斥; 不自动关闭另一边. Session 修改 Route 把互斥拒绝映射为 409.

`GoalSummary` 包含 `id`, `sessionId`, `objective`, `status`, `reason`, `createdAt`, `updatedAt`, `completedAt`. 这是设置 Data 页按 Session 查询的列表形状, 不是统计或模型生成摘要. SQL 只选择这些列, GoalStore 映射业务名称; 不带 `feedback`, `error` 或修改用的 `version`, 不额外保存摘要. 点开后用 `get` 读取完整 Goal, 修改必须使用详情的当前版本.

## HTTP 与前端 API

Server 将唯一 GoalStore 挂到 `/api/goals`, 前端 `apps/desktop/src/api/goals.ts` 通过 Hono RPC 调用, 请求/响应类型从 Route 推导. 未增加浏览器端 Goal/Storage 运行时依赖, 前端状态 Store 或重试包装.

| 端点 | 响应与职责 |
| --- | --- |
| `GET /api/goals?sessionId=...` | `{ items: GoalSummary[] }`, 按创建时间倒序, 同时间按 ID 倒序. |
| `GET /api/goals/current?sessionId=...` | `{ goal: Goal \| null }`, 只读取当前 active/paused. |
| `GET /api/goals/:goalId?sessionId=...` | `{ goal: Goal }`, 读取完整详情; 指定 Session 中不存在则 404. |
| `POST /api/goals` | 接收 sessionId/objective, 新建 active Goal, 返回 201 与 `{ goal }`. |
| `PUT /api/goals/:goalId` | 接收 sessionId/expectedVersion/objective, 只修改正文, 返回 `{ goal }`. |
| `POST /api/goals/:goalId/pause` | 接收 sessionId/expectedVersion, 返回 `{ goal }`. |
| `POST /api/goals/:goalId/activate` | 接收 sessionId/expectedVersion, 返回 `{ goal }`. |
| `POST /api/goals/:goalId/cancel` | 接收 sessionId/expectedVersion, completed/cancelled 保留历史, 返回 `{ goal }`. |
| `DELETE /api/goals/:goalId` | 接收 sessionId/expectedVersion 的 JSON body, 物理删除, 返回 204 无正文. |

列表或 current 查询没有记录时返回空数组或 null, 不把不存在的 Session 当成需要创建的目标. 写入的目标正文非空, expectedVersion 为正整数, 写入 body 拒绝额外字段, 不接受万能 status/reason/error patch. 传输校验失败返回 400/invalid_request, 不存在返回 404, 版本/状态/已有未关闭目标/Plan 互斥返回 409. 未知异常交给统一 HTTP 错误处理.

错误响应使用现有 `ServerApiError` 的 status/code/message, 不增加其中没有消费方的 currentGoal 字段. UI 收到冲突后应重新查询 current 或指定详情并让用户重新决定, 不套用新版 version 自动重试旧操作. HTTP 不提供模型进度或成功/失败报告入口, 这些仍由根 Goal 工具负责. Route 不直接启动 Turn 或调用模型, 也不在取消/删除时 abort 当前 Turn; 创建/激活的提交事件由现有队列消费.

## 事件

`goal_created`, `goal_updated`, `goal_paused`, `goal_activated`, `goal_completed`, `goal_failed`, `goal_cancelled` 携带完整 `goal`. `goal_deleted` 只携带被删除的 `sessionId` 和 `goalId`. 一次修改只发对应事件, 不给创建再发 activated 或给取消再发 completed.

Server 装配把 GoalEvent 接入现有 AppEvents/SSE. 启动恢复也在整个事务提交后发 paused, 页面初次打开仍应查询数据库, 不能依赖启动时尚未连接的事件.

## 当前分段范围

第一段已实现 SQL, GoalStore, Plan 后端互斥, 提交后事件和启动暂停. 第二段已接根模型工具与每根 Turn 的持久化 Goal reminder, 并用 `012_goal_feedback.sql` 升级现有数据. 第三段已接既有 SessionContinuationQueue 的 after-turn Goal 续接与停止/运行失败暂停, 不新增调度器或模型评审. 第四段已接 Goal HTTP 管理 Route, 前端类型 API 与 Summary/详情查询. 第五段已接已有 Session 的 Commands 目标标记, 正常聊天发送创建 Goal, 输入区目标条和右侧编辑标签页. 设置 Data 界面已接只读历史列表与详情, Backup 尚未接入; 实际界面仍需验收, 不将当前代码宣称为完整可用 Goal 模式.

## 聊天输入与编辑

- 已有 Session 的 `/goal` 选择当前输入框的目标标记, 不打开新建弹窗. 首次发送仍提交正常 ChatDraft, 并将未经转换的 `submitted.text` 作为可选 `objective` 传给同一次 WebSocket 请求. 不带 objective 的发送沿用原流程.
- Session WebSocket 的 send/queue 请求带 objective 时, 在同一同步调用栈内调用唯一 GoalStore.create, 再交给现有 continuations.enqueue. 创建事件与入队合并排水微任务, 初始用户任务不额外启动第二根 Turn. 创建失败不入队.
- POST /api/goals, goalsApi.create 和 GoalCreateInput 保留. goalsApi.current 保留可选 AbortSignal 并传给请求.
- ChatInput 用局部 React 状态保存当前目标和创建标记. 首次查询后直接消费现有 Goal 事件, 取消事件前的在途查询, 不使用 React Query, 额外 Goal Store, 轮询或新重连机制.
- `chat/input/goalBar.tsx` 只显示当前 Goal 与操作入口. 点击编辑在现有右侧工作区打开编辑目标标签, Key 直接使用 goal.id. 后续编辑更新 preview, 不发送新的用户气泡.
- 编辑页的正文草稿与事件更新的 Goal 事实分开. 版本冲突不自动重试或覆盖草稿, 重新读取需用户主动点击. 关闭或删除不复活目标, 草稿仍可复制. 暂停/激活/取消通过明确 API 操作, 不停止当前 Turn.
- Plan 下不显示 Goal 命令; active/paused Goal 或未提交的目标标记阻止选择 Plan. 后端互斥仍以 SQL 中的事实为准.

## 根模型工具与 reminder

- `GoalGet` 无参数, 返回当前 active/paused Goal 或 null, 包含最新反馈.
- `GoalUpdate` 必须指定 goalId, expectedVersion 和非空 feedback. active 只报告最新累计进度, 不能激活 paused. completed 同时保存新的中小型收尾概况; reason 只能为 succeeded 或 failed, failed 必须提供 error. 完整成果总结由 Turn 最终回复承担.
- 模型没有创建, 编辑正文, 取消, 删除, 暂停或激活入口. Goal 工具既从 fork/普通子代理工具池排除, 也不向子代理工具 Context 提供 GoalStore.
- 更新成功返回新的版本. 版本冲突要求重新判断最新目标, 不允许盲目用新版本重试旧完成结论. 关闭/删除或 paused 的工具错误明确要求停止该目标, 不自行恢复.
- 每根 Turn 的现有 reminder 保存当时的 Goal 身份, 版本, 状态, 正文和反馈. paused 或无 Goal 时明确停止历史 Goal 要求. 异步召回完成后再读取 SQL; 不改写旧 reminder, 不另建空目标 Message.
- 不实现逐次模型请求的目标替换协调或统一工具拦截. 当前 Turn 不因关闭 Goal 强制中止; 之后报告进度或终态时由 Store 拒绝旧写入. 收尾后的统一队列重新读取 SQL, 已关闭或 paused 目标不生成下一轮续接.

## 续接与停止

- Goal 是 SessionContinuationQueue 的持续消息来源, 不是永久 Queue card 或后台完成通知. after-turn 领取用户输入时, 当前 Goal active 则同一 StartTurn 也带短 continuationText, 两条 Message 分别保存. 没有用户输入时保留后台通知顺序; 没有一次性内容时才生成纯 Goal continuation. 不将 objective 塞入短提示.
- Goal 不进入 `claimNextIteration`, 不在每个 loop 加消息. 新一轮的 Goal 事实仍从 reminder 和 GoalGet 获取, 不缓存唤醒时的正文或在 StartTurn 加 GoalId.
- 创建/激活后的 AppEvent 唤醒队列, 不依赖前端在线. 根 Turn 正常收尾和手动 Compact 解锁后也走同一排水入口, 空闲判断覆盖两种工作.
- 用户停止或 Turn 最终执行失败时, 暂停该 Turn 实际处理的同一个 GoalId 的当前 active 版本. 不因 feedback 或用户编辑的版本增加而漏暂停, 不碰后来新建的其他 Goal. 普通运行失败不是 Goal 的 completed/failed.
- 先结束消息/工具/交互收尾与必要暂停, 再解除 Session 占用, 最后向队列交付终态. 停止或失败不立即重试 release 的一次性内容, 内容保留到后续明确唤醒.
