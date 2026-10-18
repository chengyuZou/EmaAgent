# Session

[English](./README.md)

Session 管理会话, 项目, 消息历史和当前运行登记. `SessionStore` 通过 Storage 仓库执行业务规则; `SessionRunningRegistry` 在进程内保存 Turn/手动压缩身份和取消信号.

## 会话与项目

创建 Store 时传入数据 `Database`, 可选变更/文件清理回调, 以及运行登记提供的 `isWorkClosed`. `createSession` 依次使用显式 cwd, 项目主文件夹, `~/.ema-agent/workspace`. 缺少默认工作目录时创建它. 项目归属和后续文件夹变化不改已有 Session cwd.

Provider/模型成对保存, 推理 `off` 明确关闭推理. 权限和 TTS 选择影响之后的 Turn. 切换 Plan 时在同一 SQL 事务检查未完成 Goal, 冲突则同请求所有字段都不修改.

侧栏只读未归档会话, 分成置顶 Session, 置顶项目, 其他项目和最近会话. 同时置顶且属于项目的 Session 只进入置顶桶. `moveSessionInSidebar` 同时修改归属, 置顶和插入位置, 拖入置顶会清除项目归属. 列表/搜索从数据库计算运行状态, 最新 Turn 状态和未读状态; 普通 `getSession` 只返回 Session 本身.

`updateTitleIfDefault` 在 SQL 检查默认标题后才写入, 避免自动命名覆盖用户改名. 归档会话有独立元数据列表. `getSessionForWork` 拒绝归档或停止中的会话, 历史读取与结束前最后的消息保存仍可进行.

## 消息与摘要

`appendMessage` 检查 Turn 归属, 序列化块并在插入成功后发送消息变更. 它不生成标题. `updateMessageBlocks` 在原 Message ID 上整体替换内容, 不逐增量发送事件.

用户消息可包含文本/媒体, 工具结果, `image_reference`, `pasted_text_reference`, `file_reference` 和 `skill_reference`. 助手消息保留原生块顺序. `parseMessageBlocksJson` 按角色检查数据库 JSON, 无效内容返回可读占位文本. [Context](../context/README-zh.md) 再把存储引用转成模型输入.

`appendHistorySummary` 要求同一 Session 的覆盖截止 Message ID, 与摘要一起保存估算减少量. 自动摘要属于当前 Turn, 手动摘要的 Turn ID 为 null. 原消息仍留在数据库.

```text
存储顺序:     covered A, covered B, retained C, summary S, later D
S 覆盖到:     B
loadHistory:  S, C, D
```

摘要插入时间不是覆盖边界. `loadHistory` 按模型顺序返回最新摘要和未覆盖消息, 默认最多 500 条. 界面使用 `listMessages` 或 `listMessagesAround`, 结果始终旧到新, 游标包含 createdAt/ID 并编码成不透明字符串. 默认每页 50, 最多 200; 锚点窗口默认前 20 后 30, 周围消息合计最多 100.

## Fork 与删除

`forkSession` 在一次事务复制全部历史或截至指定 Turn 的历史, 包含该 Turn, 重映射 Turn, Message 和摘要游标 ID. 受管附件仍引用源文件而非独立副本, 删除源会话后 fork 里的相关附件可能无法读取.

Server 在删除前协调停止工作. `deleteSession` 先删数据库行, 再清理文件, 即使文件清理失败仍发送列表变更. `deleteArchivedSessions` 在一次事务删除归档集合并返回实际 ID, Server 随后清理文件/缓存并发一次批量事件. 文件清理失败不回滚 SQL. 见 [sessionActions.ts](../../apps/server/src/application/sessionActions.ts).

## 运行登记

登记 `{ kind: 'turn', turnId }` 或 `{ kind: 'compact', compactId }`. 取消和清理必须身份匹配, 迟到请求不能影响新工作. abort 只发取消信号, 执行所有者完成保存后仍须调用 `clear`. `waitUntilIdle` 等待登记移除.

`runWithSessionClosed` 立即阻止单个 Session 的新工作并取消当前登记. 重叠操作全部结束后才恢复. `runWithRegistrationsClosed` 阻止全局新登记并串行执行回调, 用于角色变更. 登记属于进程状态, 不写入历史.

## 通知与检查

| 事件 | 消费方操作 |
| --- | --- |
| 带 Session ID 的 `session_list_changed` | 刷新对应会话的元数据或列表项. |
| 不带 ID 的同名事件 | 刷新项目和分组列表. |
| `session_messages_changed` | 读取该 Session 新保存的消息. |
| `sessions_deleted` | 移除这些 ID 并刷新相关列表. |

先读 [store.ts](./store.ts), 再跟进对应 Storage 查询. [sessionRunningRegistry.ts](./sessionRunningRegistry.ts) 说明取消与清理顺序. 测试使用 SQLite 检查历史, 归属, 摘要边界, 侧栏和偏好, 并独立检查运行登记.

```sh
pnpm --filter @ema-agent/session test
```
