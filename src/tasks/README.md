# Tasks

[中文](README-zh.md)

Tasks keeps a Session's work checklist in SQLite. `TaskStore` creates, reads, updates, cancels and deletes tasks through Storage's `TasksRepo`, then notifies consumers when the list changes.

## Using the store

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

`get(sessionId, taskId)` returns undefined when absent. `list(sessionId)` returns tasks in display-number order. New tasks start as `pending` at version 0. Their UUID is the update identity; `displayNumber` is a short number for that Session. Creation uses the largest existing number plus one, so deleting the highest number can allow it to be reused.

Updates and deletions require the last-read `expectedVersion`. Storage checks the version and writes in one transaction. A conflict returns `version_conflict` with the current task instead of overwriting it. Other failures are `not_found` and `invalid_update`.

An update can change subject, description, active form or status. `activeForm: null` clears it; omitting it leaves it unchanged. `action: 'cancel'` and `action: 'delete'` must each be used without other edits. Cancellation keeps the row, while deletion removes it. Completed or cancelled tasks can be reopened as pending or in progress. Completion and cancellation record the acting Turn and time; reopening clears those fields.

A changed row increments its version. Successful creation, changed updates and deletion emit `tasks_changed { sessionId }` after the database operation succeeds. An unchanged update emits nothing. Consumers reload the list rather than applying guessed field changes.

## Task reminders

When there are pending or in-progress tasks, `shouldRemind(sessionId)` checks whether at least 10 Turns have been created since the later of the latest unfinished-task update and the last saved reminder. It does not change that baseline.

The Turn preparation code calls `formatTaskContextReminder` to show short numbers, status, subject and version to the model. The reminder is dynamic Message content. Call `markReminded` only after that Message is saved, so a failed preparation does not consume the reminder interval.

## Code and checks

Start with [taskStore.ts](taskStore.ts) for mutations and SQL-to-business mapping, then [taskContext.ts](taskContext.ts) for the reminder. [Storage](../storage/repos/data/tasks.ts) owns version checks and reminder queries. The [TaskUpdate tool](../builtin-tools/tools/TaskUpdateTool/TaskUpdateTool.ts) performs model-requested edits; the [Tasks route](../../apps/server/src/routes/tasks.ts) serves the list to Desktop.

Run `pnpm --filter @ema-agent/tasks test` for reminder formatting. Database mutation and reminder-cycle coverage lives in [Storage tests](../storage/tests/repos/tasks.integration.test.ts).
