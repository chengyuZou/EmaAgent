// 列出当前 Session 的 Task 摘要,让模型看到整体进度与可启动的工作。

import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
  type ToolUseContext,
} from '@ema-agent/tools';
import type { TaskStatus, TaskStore } from '@ema-agent/tasks';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { TASK_LIST_DESCRIPTION } from './prompt.js';

/** Task 列表工具的窄 Context:只有持久存储;调用身份由 ToolInvocation 提供。 */
interface TaskListToolContext {
  taskStore: TaskStore;
}

const inputSchema = z.object({}).strict();
type TaskListInput = z.infer<typeof inputSchema>;

export interface TaskListResult {
  message: string;
  tasks: TaskListItem[];
}

export interface TaskListItem {
  id: string;
  displayNumber: number;
  subject: string;
  status: TaskStatus;
  version: number;
}

export const TaskListTool = buildTool<TaskListInput, TaskListResult, TaskListToolContext>({
  id: BuiltinTools.TaskList.id,
  name: BuiltinTools.TaskList.name,
  description: TASK_LIST_DESCRIPTION,

  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  // 只读任务查询, 内置信任放行。
  checkPermissions: async () => ({ behavior: 'allow' }),

  validateContext(ctx: ToolUseContext) {
    if (!ctx.taskStore) {
      return contextFail('Task tools are available only in the root Work Turn.');
    }
    return contextOk({ taskStore: ctx.taskStore });
  },

  async execute(_input, context, invocation): Promise<TaskListResult> {
    const items = context.taskStore.list(invocation.sessionId).map((task): TaskListItem => ({
      id: task.id,
      displayNumber: task.displayNumber,
      subject: task.subject,
      status: task.status,
      version: task.version,
    }));
    return {
      message: items.length === 0
        ? 'No tasks found in the current Session.'
        : `${items.length} task(s) found.`,
      tasks: items,
    };
  },
});
