// 列出当前 Session 的 Task 摘要;已完成的阻塞项从 blockedBy 中隐藏,让模型直接看到可启动的工作。

import { z } from 'zod';
import type { AgentRunId, TaskId } from '@ema-agent/ids';
import {
  buildTool,
  contextFail,
  contextOk,
  type ToolUseContext,
} from '@ema-agent/tools';
import type { TaskStatus, TaskStorePort } from '@ema-agent/tasks';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { TASK_LIST_DESCRIPTION } from './prompt.js';

/** Task 列表工具的窄 Context:只有持久存储;调用身份由 ToolInvocation 提供。 */
interface TaskListToolContext {
  taskStore: TaskStorePort;
}

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

export const TaskListTool = buildTool<TaskListInput, TaskListResult, TaskListToolContext>({
  id: BuiltinTools.TaskList.id,
  name: BuiltinTools.TaskList.name,
  description: TASK_LIST_DESCRIPTION,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  getPermissionIntent: () => ({
    riskLevel: 'low',
    accessType: 'read',
    promptPolicy: 'neverForTrustedBuiltin',
  }),

  validateContext(ctx: ToolUseContext) {
    if (!ctx.taskStore) {
      return contextFail('Task tools are available only in the root Work Turn.');
    }
    return contextOk({ taskStore: ctx.taskStore });
  },

  async execute(_input, context, invocation): Promise<TaskListResult> {
    const tasks = context.taskStore.list(invocation.sessionId);
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
