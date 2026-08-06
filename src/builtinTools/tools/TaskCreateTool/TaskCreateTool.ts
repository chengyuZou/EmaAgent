// 创建持久 Task,把同一份结构化快照返回模型;task_created 事件由 wiring 侧的 store 装饰器发出。

import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
  type ToolUseContext,
} from '@ema-agent/tools';
import type { TaskSnapshot, TaskStorePort } from '@ema-agent/tasks';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { TASK_CREATE_DESCRIPTION } from './prompt.js';

/** Task 写入工具的窄 Context:只有持久存储;调用身份由 ToolInvocation 提供。 */
interface TaskCreateToolContext {
  taskStore: TaskStorePort;
}

const inputSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('A brief, actionable task title in imperative form, such as "Run integration tests".'),
  description: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .describe('Complete requirements and context needed to finish the task.'),
  activeForm: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('Present continuous form shown while in progress, such as "Running integration tests".'),
}).strict();

type TaskCreateInput = z.infer<typeof inputSchema>;

export interface TaskCreateResult {
  message: string;
  task: TaskSnapshot;
}

export const TaskCreateTool = buildTool<TaskCreateInput, TaskCreateResult, TaskCreateToolContext>({
  id: BuiltinTools.TaskCreate.id,
  name: BuiltinTools.TaskCreate.name,
  description: TASK_CREATE_DESCRIPTION,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  getToolUseSummary: (input) => `创建任务:${input.subject}`,
  getPermissionIntent: () => ({
    riskLevel: 'low',
    accessType: 'write',
    promptPolicy: 'whenRequired',
  }),

  validateContext(ctx: ToolUseContext) {
    if (!ctx.taskStore) {
      return contextFail('Task tools are available only in the root Work Turn.');
    }
    return contextOk({ taskStore: ctx.taskStore });
  },

  async execute(input, context, invocation): Promise<TaskCreateResult> {
    const task = context.taskStore.create({
      sessionId: invocation.sessionId,
      turnId: invocation.turnId,
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm,
    });
    return {
      message: `Task #${task.displayNumber} created successfully: ${task.subject}`,
      task: context.taskStore.toSnapshot(task),
    };
  },
});
