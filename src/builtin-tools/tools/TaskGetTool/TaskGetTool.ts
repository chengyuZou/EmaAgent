// 读取单个 Task 的完整字段、依赖与当前活动 AgentRun;TaskUpdate 的 expectedVersion 从这里来。

import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
  type ToolUseContext,
} from '@ema-agent/tools';
import type { Task, TaskStore } from '@ema-agent/tasks';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { TASK_GET_DESCRIPTION } from './prompt.js';

/** Task 读取工具的窄 Context:只有持久存储;调用身份由 ToolInvocation 提供。 */
interface TaskGetToolContext {
  taskStore: TaskStore;
}

const inputSchema = z.object({
  taskId: z.string().uuid().describe('The stable UUID of the task to retrieve.'),
}).strict();

type TaskGetInput = z.infer<typeof inputSchema>;

export interface TaskGetResult {
  message: string;
  task: Task | null;
}

export const TaskGetTool = buildTool<TaskGetInput, TaskGetResult, TaskGetToolContext>({
  id: BuiltinTools.TaskGet.id,
  name: BuiltinTools.TaskGet.name,
  description: TASK_GET_DESCRIPTION,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  getToolUseSummary: (input) => `读取任务:${input.taskId.slice(0, 8)}`,
  // 只读任务查询, 内置信任放行。
  checkPermissions: async () => ({ behavior: 'allow' }),

  validateContext(ctx: ToolUseContext) {
    if (!ctx.taskStore) {
      return contextFail('Task tools are available only in the root Work Turn.');
    }
    return contextOk({ taskStore: ctx.taskStore });
  },

  async execute(input, context, invocation): Promise<TaskGetResult> {
    const task = context.taskStore.get(invocation.sessionId, input.taskId);
    return task
      ? {
          message: `Task #${task.displayNumber}: ${task.subject}`,
          task,
        }
      : { message: 'Task not found in the current Session.', task: null };
  },
});
