// 创建持久 Task，并把同一份结构化快照返回模型、发送给前端。

import { z } from 'zod';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';
import type { TaskSnapshot } from '@ema-agent/tasks';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

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

export const TaskCreateTool = buildTool<TaskCreateInput, TaskCreateResult>({
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
  permissionMeta: {
    riskLevel: 'low',
    accessType: 'write',
  },

  async execute(input, ctx): Promise<TaskCreateResult> {
    const store = requireTaskStore(ctx);
    const task = store.create({
      sessionId: asSessionId(ctx.sessionId),
      turnId: asTurnId(ctx.turnId),
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm,
    });
    const snapshot = store.toSnapshot(task);
    ctx.emit?.({
      type: 'task_created',
      sessionId: snapshot.sessionId,
      turnId: asTurnId(ctx.turnId),
      task: snapshot,
    });
    return {
      message: `Task #${task.displayNumber} created successfully: ${task.subject}`,
      task: snapshot,
    };
  },
});

function requireTaskStore(ctx: ToolExecutionContext) {
  if (!ctx.taskStore) {
    throw new Error('Task tools are available only in the root Work Turn.');
  }
  return ctx.taskStore;
}
