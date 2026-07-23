// 读取单个 Task 的完整字段、依赖与当前活动 AgentRun。

import { z } from 'zod';
import { asSessionId, asTaskId } from '@ema-agent/ids';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';
import type { TaskSnapshot } from '@ema-agent/turn';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

const inputSchema = z.object({
  taskId: z.string().uuid().describe('The stable UUID of the task to retrieve.'),
}).strict();

type TaskGetInput = z.infer<typeof inputSchema>;

export interface TaskGetResult {
  message: string;
  task: TaskSnapshot | null;
}

export const TaskGetTool = buildTool<TaskGetInput, TaskGetResult>({
  id: BuiltinTools.TaskGet.id,
  name: BuiltinTools.TaskGet.name,
  description: `Retrieve one task from the current Session by its stable taskId.

Use this before updating a task so you have its latest version, full description, dependency graph, and active AgentRun. A task with unresolved blockedBy entries must not be started. Use TaskList for a compact view of the whole Session.`,

  inputSchema,
  maxResultBytes: 100_000,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  getToolUseSummary: (input) => `读取任务：${input.taskId.slice(0, 8)}`,
  permissionMeta: {
    riskLevel: 'low',
    accessType: 'read',
  },

  async execute(input, ctx): Promise<TaskGetResult> {
    const store = requireTaskStore(ctx);
    const task = store.get(asSessionId(ctx.sessionId), asTaskId(input.taskId));
    return task
      ? {
          message: `Task #${task.displayNumber}: ${task.subject}`,
          task: store.toSnapshot(task),
        }
      : { message: 'Task not found in the current Session.', task: null };
  },
});

function requireTaskStore(ctx: ToolExecutionContext) {
  if (!ctx.taskStore) {
    throw new Error('Task tools are available only in the root Work Turn.');
  }
  return ctx.taskStore;
}
