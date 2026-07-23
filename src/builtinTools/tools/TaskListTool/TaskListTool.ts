// 列出当前 Session 的 Task 摘要，并隐藏已完成的阻塞关系。

import { z } from 'zod';
import { asSessionId } from '@ema-agent/ids';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';
import type { AgentRunId, TaskId } from '@ema-agent/ids';
import type { TaskStatus } from '@ema-agent/tasks';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

const inputSchema = z.object({}).strict();
type TaskListInput = z.infer<typeof inputSchema>;

export interface TaskListResult {
  message: string;
  tasks: TaskListItem[];
}

export interface TaskListItem {
  id: TaskId;
  displayNumber: number;
  subject: string;
  status: TaskStatus;
  blockedBy: TaskId[];
  activeAgentRunId?: AgentRunId;
  version: number;
}

export const TaskListTool = buildTool<TaskListInput, TaskListResult>({
  id: BuiltinTools.TaskList.id,
  name: BuiltinTools.TaskList.name,
  description: `List all persistent tasks in the current Session.

Use this before creating tasks to avoid duplicates, after completing a task to find newly unblocked work, and whenever you need an overall progress snapshot.

Prefer lower display numbers when several tasks are available because earlier tasks often establish context for later work. A task is available when it is pending, has no unresolved blockedBy entries, and has no activeAgentRunId. Use TaskGet for the complete description before starting.`,

  inputSchema,
  maxResultBytes: 100_000,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  permissionMeta: {
    riskLevel: 'low',
    accessType: 'read',
  },

  async execute(_input, ctx): Promise<TaskListResult> {
    const store = requireTaskStore(ctx);
    const tasks = store.list(asSessionId(ctx.sessionId));
    const completed = new Set(
      tasks.filter((task) => task.status === 'completed').map((task) => task.id),
    );
    const items = tasks.map((task): TaskListItem => ({
      id: task.id,
      displayNumber: task.displayNumber,
      subject: task.subject,
      status: task.status,
      blockedBy: task.blockedBy.filter((taskId) => !completed.has(taskId)),
      version: task.version,
      ...(task.activeAgentRunId !== undefined
        ? { activeAgentRunId: task.activeAgentRunId }
        : {}),
    }));
    return {
      message: items.length === 0
        ? 'No tasks found in the current Session.'
        : `${items.length} task(s) found.`,
      tasks: items,
    };
  },
});

function requireTaskStore(ctx: ToolExecutionContext) {
  if (!ctx.taskStore) {
    throw new Error('Task tools are available only in the root Work Turn.');
  }
  return ctx.taskStore;
}
