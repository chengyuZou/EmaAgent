# Session

`src/session` 拥有持久会话、项目分组与消息历史的**业务规则**：什么能写、怎么写、写完联动什么。SQL 归 storage，协议归 server，Turn 执行归 turn 包。

## 领域事实

- **Session**：标题、workspaceRoot（项目内锁定为项目主文件夹）、projectId、createdAt/updatedAt/lastActivityAt、archivedAt、pinned、fork 溯源双列、executionProfile、narrativePolicy、当前模型（providerId/ModelId）、lastViewedAt。
- **SessionListItem** = Session + 列表投影三字段（hasActiveTurn / lastTurnStatus / hasUnread）。三字段只由列表/搜索 SQL 的 CTE 算出；单查路径返回裸 Session，不允许伪造投影。
- **Project**：可编辑名称 + 多源文件夹，恰好一个主文件夹（按 updatedAt 倒序首位即主）。
- **Message**：sessionId、可空 turnId（null = /compact summary 等 Session 级消息）、role、kind（normal / tool_results / summary）、blocks、interrupted、createdAt。

## 公共入口

`SessionStore` 是唯一读写聚合：

- **Session**：createSession / getSession / sessionExists / patchSession（项目成员改工作区抛 `session_workspace_locked_by_project`）/ pin / archive / setViewedAt / updateTitle；
- **侧栏**：`listSessionsGrouped()` 五桶（置顶 Session / 置顶项目 / 其余项目 / 最近 / 已归档；Session 同时满足 pinned 与 project 时进置顶桶）；`searchSessions` 不搜归档；
- **Project**：createProject / rename / delete / pin / 文件夹增删 / 设主 / 拖入拖出；主文件夹变更或继位时同事务级联改写全部成员的 workspace_root；
- **Fork**：forkSession 复制 Turn/Message/Attachment 并重映射 ID，不带 Task、AgentRun 或任何在跑的外部副作用；
- **Message**：appendMessage（turnId 归属校验）/ loadHistory（从最近 summary 起，LLM 可见历史）/ listMessages（热尾游标）/ listMessagesForTurns（供 Turn 窗口拼装）/ loadMessagesForTurn / findToolInteraction（启动恢复）/ markMessageInterrupted / assertMessageOwnership；
- **删除**：deleteSession 只删本聚合的数据库行并触发 onSessionRemoved 文件清理；活动 Turn 的取消与运行态收口归 TurnStore，由删除用例（Server 编排）先行调用。

其余出口：

- `generateSessionTitle(query, complete)`：让模型生成 7–15 字标题，失败或为空时截断原文前 100 字兜底；返回空串表示没有可用输入。持久化不在此发生，调用方拿返回值走 `SessionStore.updateTitle`。
- `parseMessageBlocksJson`：blocks_json 的唯一解析点。
- `SessionOwnershipError`：跨 Session 引用的稳定错误。

## 边界（本包不负责）

- Turn 生命周期、运行态（取消信号/运行锁）、导航查询、rewind、Session 删除守卫 → `@ema-agent/turn` 的 `TurnStore`；
- Wire DTO 不在本包——server/desktop 的协议类型在接线批按真实消费方重建；
- 跨包删除编排（Runtime/Permission/Memory 级联）→ server 侧的 SessionLifecycle。

## 依赖方向

```text
session ──> ids / storage / @ema-agent/turn/turns（零依赖词汇叶，唯一允许导入的 turn 文件）
```

不 import turn 业务实现、agent、context、compact、memory、permission 或应用 Route。
