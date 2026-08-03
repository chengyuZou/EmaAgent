// 读取单个 Task 的完整字段、依赖与当前活动 AgentRun。

import { z } from 'zod';
import { asTaskId } from '@ema-agent/ids';
import type { SessionId } from '@ema-agent/ids';
import { buildTool, contextFail, contextOk, type BuiltinToolContext } from '@ema-agent/tools';
import type { TaskSnapshot, TaskStorePort } from '@ema-agent/tasks';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

/** Task 读取工具的窄 Context：持久存储 + 调用身份。 */
interface TaskGetToolContext {
  taskStore: TaskStorePort;
  sessionId: SessionId;
}

const inputSchema = z.object({
  taskId: z.string().uuid().describe('The stable UUID of the task to retrieve.'),
}).strict();

type TaskGetInput = z.infer<typeof inputSchema>;

export interface TaskGetResult {
  message: string;
  task: TaskSnapshot | null;
}

export const TaskGetTool = buildTool<TaskGetInput, TaskGetResult, BuiltinToolContext, TaskGetToolContext>({
  id: BuiltinTools.TaskGet.id,
  name: BuiltinTools.TaskGet.name,
  description: `Retrieve one task from the current Session by its stable taskId.

Use this before updating a task so you have its latest version, full description, dependency graph, and active AgentRun. A task with unresolved blockedBy entries must not be started. Use TaskList for a compact view of the whole Session.`,

  inputSchema,
  maxResultBytes: 100_000,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  getToolUseSummary: (input) => `读取任务：${input.taskId.slice(0, 8)}`,
  getPermissionIntent: () => ({
    riskLevel: 'low',
    accessType: 'read',
    promptPolicy: 'neverForTrustedBuiltin',
  }),

  requires: ['taskStore'],

  validateContext(ctx) {
    if (!ctx.taskStore) {
      return contextFail('Task tools are available only in the root Work Turn.');
    }
    return contextOk({
      taskStore: ctx.taskStore,
      sessionId: ctx.sessionId,
    });
  },

  async execute(input, context): Promise<TaskGetResult> {
    const task = context.taskStore.get(context.sessionId, asTaskId(input.taskId));
    return task
      ? {
          message: `Task #${task.displayNumber}: ${task.subject}`,
          task: context.taskStore.toSnapshot(task),
        }
      : { message: 'Task not found in the current Session.', task: null };
  },
});
