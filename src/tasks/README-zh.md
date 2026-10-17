# Tasks

[English](README.md)

Tasks 将每个 Session 的工作清单保存在 SQLite. `TaskStore` 通过 Storage 的 `TasksRepo` 创建, 读取, 更新, 取消和删除任务, 清单变化后通知消费方.

## 使用 Store

```ts
import { TaskStore } from '@ema-agent/tasks';
import { TasksRepo } from '@ema-agent/storage';

const tasks = new TaskStore(new TasksRepo(dataDb.sqlite), emit);
const task = tasks.create({
  sessionId,
  turnId,
  subject: 'Check the release',
  description: 'Run the release checks and inspect their output.',
});
const result = tasks.update({
  sessionId,
  turnId,
  taskId: task.id,
  expectedVersion: task.version,
  status: 'in_progress',
});
```

`get(sessionId, taskId)` 在任务不存在时返回 undefined. `list(sessionId)` 按展示序号返回清单. 新任务为 `pending`, 版本为 0. 更新使用 UUID; `displayNumber` 只是 Session 内便于展示的短序号. 创建时取现有最大序号加一, 因此删除最大序号后可能复用该数字.

更新和删除必须提交上次读取的 `expectedVersion`. Storage 在同一个事务里检查版本并写入. 冲突返回 `version_conflict` 和当前任务, 不覆盖新值. 其他失败为 `not_found` 和 `invalid_update`.

更新可以修改标题, 描述, 进行中的描述或状态. `activeForm: null` 清空该描述, 不传则保持原值. `action: 'cancel'` 和 `action: 'delete'` 都必须单独使用, 不能同时修改其他字段. 取消保留记录, 删除移除记录. 已完成或取消的任务可以重新设为待办或进行中. 完成和取消记录操作 Turn 及时间, 重新打开会清除这两个字段.

行内容变化时版本加一. 创建, 实际更新和删除成功后发送 `tasks_changed { sessionId }`. 无变化的更新不发事件. 消费方收到后重新查询清单.

## 任务提醒

存在待办或进行中的任务时, `shouldRemind(sessionId)` 检查是否到了提醒周期. 基准取未完成任务的最近更新时间和上次已保存提醒时间中较晚的一个, 默认其后创建至少 10 个 Turn 才提醒. 检查本身不改基准.

Turn 准备阶段使用 `formatTaskContextReminder` 向模型提供短序号, 状态, 标题和版本, 作为动态 Message 内容. 必须先保存提醒 Message, 再调用 `markReminded`, 避免准备失败也用掉本次提醒.

## 代码与验证

[taskStore.ts](taskStore.ts) 包含修改入口及 SQL 到业务字段的转换, [taskContext.ts](taskContext.ts) 生成提醒. [Storage](../storage/repos/data/tasks.ts) 实现版本检查与提醒查询. 模型通过 [TaskUpdate 工具](../builtin-tools/tools/TaskUpdateTool/TaskUpdateTool.ts) 修改任务, Desktop 通过 [Tasks Route](../../apps/server/src/routes/tasks.ts) 查询清单.

运行 `pnpm --filter @ema-agent/tasks test` 检查提醒格式. 数据库修改和提醒周期测试位于 [Storage 测试](../storage/tests/repos/tasks.integration.test.ts).
