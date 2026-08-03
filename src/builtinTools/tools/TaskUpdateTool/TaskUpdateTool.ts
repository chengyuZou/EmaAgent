// 使用 expectedVersion 原子更新 Task 字段、状态和依赖，拒绝陈旧写与依赖环。

import { z } from 'zod';
import { asTaskId } from '@ema-agent/ids';
import type { SessionId, TurnId } from '@ema-agent/ids';
import { buildTool, contextFail, contextOk, type BuiltinToolContext } from '@ema-agent/tools';
import type { ToolExecutionEvent } from '@ema-agent/tools';
import type { TaskSnapshot, TaskStorePort, TaskMutationFailure } from '@ema-agent/tasks';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

/** Task 更新工具的窄 Context：持久存储 + 可选事件输出 + 调用身份。 */
interface TaskUpdateToolContext {
  taskStore: TaskStorePort;
  emit?: (event: ToolExecutionEvent) => void;
  sessionId: SessionId;
  turnId: TurnId;
}

const taskIdList = z.array(z.string().uuid()).max(100);

const inputSchema = z.object({
  taskId: z.string().uuid().describe('The stable UUID of the task to update.'),
  expectedVersion: z
    .number()
    .int()
    .nonnegative()
    .describe('The latest task version returned by TaskGet or TaskList. Stale versions are rejected.'),
  subject: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(20_000).optional(),
  activeForm: z
    .union([z.string().trim().min(1).max(200), z.null()])
    .optional()
    .describe('New present-continuous label; null removes it.'),
  status: z
    .enum(['pending', 'in_progress', 'completed'])
    .optional()
    .describe('New normal workflow status. Use action for cancellation or deletion.'),
  action: z
    .enum(['cancel', 'delete'])
    .optional()
    .describe('Explicit destructive action. cancel keeps history; delete removes the Task.'),
  addBlocks: taskIdList.optional().describe('Tasks that cannot start until this task completes.'),
  addBlockedBy: taskIdList.optional().describe('Tasks that must complete before this task can start.'),
  removeBlocks: taskIdList.optional().describe('Downstream dependencies to remove.'),
  removeBlockedBy: taskIdList.optional().describe('Upstream dependencies to remove.'),
}).strict().superRefine((value, ctx) => {
  const actionHasOtherMutation = value.action !== undefined && (
    value.status !== undefined
    || value.subject !== undefined
    || value.description !== undefined
    || value.activeForm !== undefined
    || value.addBlocks !== undefined
    || value.addBlockedBy !== undefined
    || value.removeBlocks !== undefined
    || value.removeBlockedBy !== undefined
  );
  if (actionHasOtherMutation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'action must be submitted alone and cannot be combined with other mutations',
    });
  }
  const hasMutation = Object.entries(value).some(
    ([key, item]) => key !== 'taskId' && key !== 'expectedVersion' && item !== undefined,
  );
  if (!hasMutation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'at least one field, dependency change, status, or action is required',
    });
  }
});

type TaskUpdateInput = z.infer<typeof inputSchema>;

export interface TaskUpdateResult {
  success: boolean;
  message: string;
  changed: boolean;
  deleted: boolean;
  taskId: string;
  task?: TaskSnapshot;
  current?: TaskSnapshot;
  reason?: TaskMutationFailure;
}

export const TaskUpdateTool = buildTool<TaskUpdateInput, TaskUpdateResult, BuiltinToolContext, TaskUpdateToolContext>({
  id: BuiltinTools.TaskUpdate.id,
  name: BuiltinTools.TaskUpdate.name,
  description: `Update a persistent task in the current Session.

Read the latest TaskGet or TaskList snapshot first and pass its expectedVersion. A stale update is rejected instead of overwriting newer work.

Mark a task in_progress before beginning. Mark it completed immediately only after the described work is fully finished and verified. Failing tests, partial implementation, unresolved errors, or missing dependencies do not count as completed.

Use addBlocks/addBlockedBy to establish dependencies and removeBlocks/removeBlockedBy to correct them. A task with unresolved blockers cannot enter in_progress or completed. Dependency cycles are rejected.

Use action="cancel" when work is intentionally abandoned but history should remain. Use action="delete" only for a duplicate or mistakenly created task. AgentRun completion never completes a Task automatically; the root Agent must inspect the result and call TaskUpdate explicitly.`,

  inputSchema,
  maxResultBytes: 100_000,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  getToolUseSummary: (input) => {
    const operation = input.action ?? input.status ?? '更新字段';
    return `更新任务：${input.taskId.slice(0, 8)} → ${operation}`;
  },
  getPermissionIntent: () => ({
    riskLevel: 'low',
    accessType: 'write',
    promptPolicy: 'whenRequired',
  }),

  requires: ['taskStore'],

  validateContext(ctx) {
    if (!ctx.taskStore) {
      return contextFail('Task tools are available only in the root Work Turn.');
    }
    return contextOk({
      taskStore: ctx.taskStore,
      ...(ctx.emit ? { emit: ctx.emit } : {}),
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
    });
  },

  async execute(input, context): Promise<TaskUpdateResult> {
    const sessionId = context.sessionId;
    const turnId = context.turnId;
    const taskId = asTaskId(input.taskId);
    const result = context.taskStore.update({
      sessionId,
      turnId,
      taskId,
      expectedVersion: input.expectedVersion,
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm,
      status: input.status,
      action: input.action,
      addBlocks: input.addBlocks?.map(asTaskId),
      addBlockedBy: input.addBlockedBy?.map(asTaskId),
      removeBlocks: input.removeBlocks?.map(asTaskId),
      removeBlockedBy: input.removeBlockedBy?.map(asTaskId),
    });

    if (!result.ok) {
      return {
        success: false,
        message: failureMessage(result.reason, result.taskId),
        changed: false,
        deleted: false,
        taskId,
        reason: result.reason,
        ...(result.current ? { current: context.taskStore.toSnapshot(result.current) } : {}),
      };
    }

    if (result.deleted) {
      context.emit?.({ type: 'task_deleted', sessionId, turnId, taskId });
      return {
        success: true,
        message: `Task ${input.taskId} deleted.`,
        changed: true,
        deleted: true,
        taskId,
      };
    }

    const snapshot = context.taskStore.toSnapshot(result.task);
    if (result.changed) {
      context.emit?.({ type: 'task_updated', sessionId, turnId, task: snapshot });
    }
    return {
      success: true,
      message: result.changed
        ? `Task #${snapshot.displayNumber} updated to version ${snapshot.version}.`
        : `Task #${snapshot.displayNumber} already matches the requested state.`,
      changed: result.changed,
      deleted: false,
      taskId,
      task: snapshot,
    };
  },
});

function failureMessage(reason: TaskMutationFailure, relatedTaskId?: string): string {
  switch (reason) {
    case 'not_found':
      return 'Task not found in the current Session.';
    case 'version_conflict':
      return 'Task changed since it was read. Call TaskGet and retry with the latest version.';
    case 'blocked':
      return 'Task has unresolved dependencies and cannot enter the requested status.';
    case 'active_agent_run':
      return 'Task still has an active AgentRun and cannot enter a terminal state or be deleted.';
    case 'dependency_not_found':
      return `Dependency Task ${relatedTaskId ?? ''} was not found in the current Session.`.trim();
    case 'dependency_cycle':
      return `Dependency change would create a cycle involving Task ${relatedTaskId ?? ''}.`.trim();
    case 'invalid_update':
      return 'Task update is invalid. Submit cancel or delete as a standalone action.';
  }
}
