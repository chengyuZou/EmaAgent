// 创建持久 Task，并把同一份结构化快照返回模型、发送给前端。

import { z } from 'zod';
import type { SessionId, TurnId } from '@ema-agent/ids';
import { buildTool, contextFail, contextOk, type BuiltinToolContext } from '@ema-agent/tools';
import type { ToolExecutionEvent } from '@ema-agent/tools';
import type { TaskSnapshot, TaskStorePort } from '@ema-agent/tasks';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

/** Task 写入工具的窄 Context：持久存储 + 可选事件输出 + 调用身份。 */
interface TaskCreateToolContext {
  taskStore: TaskStorePort;
  emit?: (event: ToolExecutionEvent) => void;
  sessionId: SessionId;
  turnId: TurnId;
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

export const TaskCreateTool = buildTool<TaskCreateInput, TaskCreateResult, BuiltinToolContext, TaskCreateToolContext>({
  id: BuiltinTools.TaskCreate.id,
  name: BuiltinTools.TaskCreate.name,
  description: `Create a persistent task in the current Session's structured task list.

Use Task tools proactively when work has at least three meaningful steps, when the user gives several requests, or when a non-trivial task benefits from visible progress tracking.

Do not create tasks for a single trivial action, a short informational answer, or purely conversational work.

Before creating tasks, call TaskList to avoid duplicates. Use an imperative subject, put enough context in description for future Turns to resume the work, and use TaskUpdate to add dependencies after creation.

New tasks always start as pending. Mark a task in_progress before beginning it and completed immediately after the work is fully finished and verified.`,

  inputSchema,
  maxResultBytes: 100_000,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  getToolUseSummary: (input) => `创建任务：${input.subject}`,
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

  async execute(input, context): Promise<TaskCreateResult> {
    const task = context.taskStore.create({
      sessionId: context.sessionId,
      turnId: context.turnId,
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm,
    });
    const snapshot = context.taskStore.toSnapshot(task);
    context.emit?.({
      type: 'task_created',
      sessionId: snapshot.sessionId,
      turnId: context.turnId,
      task: snapshot,
    });
    return {
      message: `Task #${task.displayNumber} created successfully: ${task.subject}`,
      task: snapshot,
    };
  },
});
