# Goal

[English](README.md)

`@ema-agent/goal` 保存 Session 的持续目标, 最新进度和最终结果. `GoalStore` 检查状态与版本, 再通过 Storage 写入数据库.

## 使用

```ts
const goals = new GoalStore(dataDb, emit, isSessionWorkClosed);
const goal = goals.create(sessionId, '准备发布');
const reported = goals.reportFeedback({
  sessionId,
  goalId: goal.id,
  expectedVersion: goal.version,
}, '构建和测试通过, 还需检查安装包.');

const current = goals.getCurrent(sessionId);
```

构造函数的第三个参数可选, 用于在 Session 正在停止时拒绝创建或激活. Server 传入会话运行登记的检查函数. `getCurrent` 返回 active/paused 目标或 null, `get(sessionId, goalId)` 读取完整记录. `listSummaries(sessionId)` 按创建时间和 ID 倒序返回历史列表, 反馈, 错误详情和修改所需版本通过 `get` 另读.

## 状态和修改

| 操作 | 允许状态 | 结果 |
| --- | --- | --- |
| `create` | Session 没有 active/paused 目标. | 创建 active 目标, version 为 1. |
| `edit` | active 或 paused. | 保存目标正文原有空白, 清空旧反馈. |
| `reportFeedback` | active. | 替换最新进度说明. |
| `pause` / `activate` | active 或 paused. | 在两个未完成状态之间切换. |
| `complete` / `fail` | active. | completed, reason 为 succeeded/failed, 同时保存新的收尾反馈. |
| `cancel` | active 或 paused. | completed, reason 为 cancelled, 保留最后反馈. |
| `delete` | 任意现存状态. | 物理删除指定目标. |

只有最终失败保存 error. 已完成目标仍能读取, 不能编辑或激活. SQL 限制每个 Session 最多一条 active/paused 目标. 创建与激活拒绝不存在, 已归档, 正在停止或处于 Plan 模式的 Session. Session 修改权限时检查 Plan/Goal 互斥的另一侧.

修改和删除都传入 `GoalIdentity`, 包含 sessionId, goalId 和 expectedVersion. 读取, 版本检查, 状态检查和写入处于同一个同步 SQLite 事务. 真正修改才递增版本; 相同正文, 反馈或状态不重复写入和发事件, 但仍检查版本. 迟到请求不会被套用到后来新建的目标.

`GoalError.code` 表示拒绝原因. `current` 保存发生冲突时读到的目标; 指定 ID 不存在时, 可以包含当前未完成目标. 调用方应重新判断最新事实, 不能拿新版本自动重试旧的完成结论.

## 事件和接入

```text
HTTP / Goal 工具 / 启动恢复
    -> GoalStore -> SQLite 事务提交
        -> GoalEvent -> Server 应用事件
            -> UI 更新和续接队列
```

修改事件携带完整 Goal, `goal_deleted` 只携带 sessionId 和 goalId. `goal_edited` 表示正文改变, `goal_updated` 表示反馈改变, 执行队列据此区分后续处理.

Server 就绪前调用 `pauseActiveOnStartup()`, 将持久化的 active 改为 paused, 递增版本并在事务提交后发事件. 保留目标 ID 和进度, 不在重启后自动继续工作.

用户操作经 [Goal 路由](../../apps/server/src/routes/goals.ts) 和 [聊天发送路由](../../apps/server/src/routes/ws/session.ts) 进入. 模型进度和终态通过 [GoalUpdate](../builtin-tools/tools/GoalUpdateTool/GoalUpdateTool.ts) 提交. [续接队列](../turn/sessionContinuationQueue.ts) 决定 active 目标何时产生下一 Turn. 暂停目标停止后续续接, 本身不取消当前 Turn.

当前尚无整个 Goal 的 Token 总预算或跨 Turn 空转停止规则. 对应未完成事项保留在受影响实现旁.

## 验证

[goalStore.ts](goalStore.ts) 保存状态修改规则, [types.ts](types.ts) 说明身份与结果字段, [Storage Goal Repo](../storage/repos/data/goals.ts) 保存 SQL 操作.

```sh
pnpm --filter @ema-agent/goal test
pnpm --filter @ema-agent/goal typecheck
```

测试使用真实 SQLite 记录, 检查状态变化, 旧版本写入, 提交后事件, 重启恢复和 Session 删除.
