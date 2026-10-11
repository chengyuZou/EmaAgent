# Session

`src/session` 拥有持久会话、项目与消息历史的**业务规则**：什么能写、怎么写、写完联动什么。SQL 归 storage，协议归 server，Turn 执行归 turn 包。

## 领域事实

- **Session**: 标题, 非空 `cwd`, projectId, createdAt/updatedAt/lastActivityAt, archivedAt, pinned, fork 溯源双列, permissionMode, ttsEnabled, 当前模型(providerId/modelId), 推理强度(reasoningEffort)与 lastViewedAt. 模型身份成对保存, `'off'` 表示关闭推理; 普通消息不携带本轮覆盖值. `ttsEnabled` 是每个 Session 自己的语音选择, 创建时从新对话草稿写入, 后续由 Session patch 修改; 直接发送和排队续接都在 Turn 启动时读取它, 不从消息请求或队列选项读取. `cwd` 是命令和相对路径的起点, 新建时选定, 此后只由用户显式修改. Storage 的 `sidebar_order` 只表达所在侧栏分区内的顺序, 不进入 Session API; 拖放与新 Turn 开始会更新它.
- **SessionListItem** = Session + 列表投影三字段（hasActiveTurn / lastTurnStatus / hasUnread）。三字段只由列表/搜索 SQL 的 CTE 算出；单查路径返回裸 Session，不允许伪造投影。
- **Project**：id、name、pinned、createdAt、updatedAt、folders[]、sessions[]。可以没有源文件夹；有文件夹时其中一个为主。侧栏 Project 的 sessions[] 只包含当前在项目区显示的成员，置顶 Session 单独进入置顶桶。Storage 的 `sidebar_order` 独立保存 Project 在置顶/普通项目区的顺序。
- **Message**：sessionId、可空 turnId（null = /compact summary 等 Session 级消息）、role、kind（normal / reminder / tool_results / summary）、blocks、interrupted、createdAt。用户块允许 `attachment_ref` 与 `skill_ref`，只保存稳定引用，不复制附件正文或 SKILL.md。

## 公共入口

压缩摘要的 `SessionMessage.savedTokens` 是压缩前后完整请求 Token 估算的减少量, 由 Compact 计算并与摘要一起保存到 `messages.summary_saved_tokens`. 手动和自动压缩使用同一字段, Fork 和备份保留它. 未记录该值的历史摘要不补造数字. 聊天只显示压缩提示与减少量, 正文仍保存在 `blocks` 中供设置页查看.

`SessionStore` 是唯一读写聚合：

- **Session**：createSession（可同时携带 projectId 与显式 cwd；未给 cwd 时取创建当刻的项目主文件夹；项目无主文件夹或无项目时，创建并使用 `~/.ema-agent/workspace`）/ getSession / sessionExists / patchSession（项目成员也可显式改 cwd）/ pin / archive / setViewedAt / updateTitle；
- **侧栏**: `listSessionsForSidebar()` 只返回未归档会话, 分为置顶 Session, 置顶项目, 其余项目和最近会话. Session 同时满足 pinned 与 project 时进入置顶桶. `moveSessionInSidebar` 一次提交归属、置顶与插入位置, 拖入置顶会清空 projectId; `moveProjectInSidebar` 一次提交项目分区和插入位置; 新 Turn 开始时 Session 回到当前分区顶部. `searchSessions` 不搜归档.
- **归档概况**: `listArchivedSessions()` 单独返回完整标题, 项目 ID 和名称, 归档时间, 不读取消息正文. Desktop 的 Settings 归档页只按完整标题搜索, 项目另行筛选, 不提供发送入口. 取消归档保留原项目, 置顶和历史, 不自动恢复执行.
- **Project**：createProject(name, folderPaths, primaryFolderPath?) 在一次事务中创建项目及全部源文件夹；listProjectFolders(projectId) 给 Skills、Permission 读取项目全部源文件夹；rename / delete / pin / 文件夹增删 / 设主 / 拖入拖出。设主、移除文件夹、拖入项目均不改旧 Session 的 cwd；设主只影响以后新建的 Session。
- **Fork**：forkSession 复制 Turn/Message/Attachment 并重映射 ID，不带 Task、Subagent 或任何在跑的外部副作用；
- **Message**：appendMessage（turnId 归属校验）/ appendHistorySummary（自动压缩带当前 turnId，手动压缩为 null，且必须带覆盖截止游标）/ loadHistory（最新 summary + 其覆盖游标之后的消息，LLM 可见历史）/ listMessages（UI 正文复合游标页，旧到新）/ listMessagesAround（按 Message 锚点读取有界窗口）/ loadMessagesForTurn（Turn 终态持久收口）/ findToolInteraction（启动恢复）/ markMessageInterrupted / assertMessageOwnership；
- **删除**：deleteSession 只删本聚合的数据库行并触发 onSessionRemoved 文件清理；活动 Turn 的取消与运行态收口归 TurnStore，由删除用例（Server 编排）先行调用。

其余出口：

- `SessionRunningRegistry`: 同一 Session 只记录一个当前根工作, 身份为根 Turn(kind='turn')或手动 Compact(kind='compact'). `runWithSessionClosed` 同步关闭指定会话的新工作入口并取消根工作, 操作结束后解除临时关闭; `waitUntilIdle` 等实际执行者完成清理. `getSessionForWork` 供宿主在排队、启动子代理或命令前取得未归档且没有正在停止的会话, 归档或停止中抛出 `SessionWorkBlockedError`. `getSession` 和消息保存仍可用于查看历史及执行结束前的最后保存.
- `parseMessageBlocksJson`：blocks_json 的唯一解析点。
- `collectAttachmentReferenceIds`：一次批量收集消息里全部附件引用 id，供历史重放前批量预取附件。
- `SessionOwnershipError`：跨 Session 引用的稳定错误。

`SessionStoreDeps.onChanged` 在对应写入成功后接收 `SessionEvent`：`session_list_changed` 表示侧栏会话或项目投影须重查；`session_messages_changed { sessionId }` 表示该会话新增了持久 Message。流式 Message 块更新不逐次广播，完整正文以 Turn 终态事件为刷新边界。导入备份和末轮回退绕过本 Store 写入口，分别由 Server 导入路由和 TurnStore 清理回调在提交后发相同事件。

`patchSession` 切换 Permission 为 plan 时, 在同一 SQL 事务内检查 Goals 当前事实.
active 或 paused 都表示目标未关闭, 拒绝切换并抛出 `SessionPlanGoalConflictError`,
其 `goalId` 指出需要用户关闭的目标. 同请求的其它字段也不写入, 不发成功事件.
完成或删除目标后才允许切 Plan. SessionStore 只读取 Storage 的 GoalRow,
不导入 Goal 业务包, 不代替用户取消目标. 反方向的新建/激活检查由 GoalStore 负责.

## 会话标题

`DEFAULT_SESSION_TITLE` 是新建时未指定标题的默认值. `appendMessage` 只保存消息, 不生成或修改标题. 自动命名由 [Turn 的发送流程](../turn/README.md#会话自动命名) 判断, 用户手动改名使用 `updateTitle`.

`updateTitleIfDefault(sessionId, title)` 在 SQL 更新时检查当前标题仍为默认值, 避免自动命名覆盖用户已经保存的标题. 更新成功后发 `session_list_changed`, Desktop 重新读取完整标题. Session 不保存截短显示值, 搜索与备份使用完整标题.

## 边界（本包不负责）

- Turn 生命周期, 导航查询和 rewind 由 `@ema-agent/turn` 的 `TurnStore` 负责; 根工作取消信号由 `SessionRunningRegistry` 保存.
- Wire DTO 不在本包——server/desktop 的协议类型在接线批按真实消费方重建；
- 跨包删除和归档流程由 Server 的 `application/sessionActions.ts` 负责.

删除和归档都由界面先显示确认 Dialog, 取消不发送请求. 确认后只发送一次请求, 不附带确认字段; Server 收到请求就同步关闭这个会话的新执行, 同时通知根 Turn/Compact, 前后台子代理, 前后台命令和语音生成停止, 取消待交互, 清空尚未保存为消息的排队输入, 把未完成 Goal 标记为取消. 归档事实先保存, 历史保留; 删除则等待所有执行完成最后的保存, 再删除数据与附件, 成功返回 204. 取消归档期间如果停止流程还没结束, 请求会被拒绝. 停止不会撤销已经完成的文件修改.

## 依赖方向

```text
session ──> storage / llm（类型）/ tools（ToolResult 类型）/ permission（PermissionMode 类型）
```

不 import turn 业务实现、agent、context、compact、memory 或应用 Route。
