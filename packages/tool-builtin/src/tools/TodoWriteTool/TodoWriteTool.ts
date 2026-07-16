// 这个工具负责更新当前 Session 的结构化待办列表并发送展示事件。
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';
import type { EmaStreamEvent } from '@ema-agent/contracts';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

// ── 类型 ─────────────────────────────────────────────────────────────────────

const todoStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);

const todoSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: todoStatusSchema,
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
});

export type Todo = z.infer<typeof todoSchema>;

// ── 内存存储(每进程,按 turnId 索引)──────────────────────────────────────
// 按 turnId(非 sessionId)索引,以便 sub-agent - 共享父 sessionId 但
// 以自己的 subagentId 作 turnId - 拿到独立列表。
// AgentEngine 在 turn 开始时调 clearTodos(turnId) 重置。

const store = new Map<string, Todo[]>();

export function getTodos(turnId: string): Todo[] {
  return store.get(turnId) ?? [];
}

export function clearTodos(turnId: string): void {
  store.delete(turnId);
}

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  todos: z
    .array(todoSchema)
    .describe(
      'Complete replacement list of todos. The entire previous list is replaced on each call.',
    ),
});

type TodoWriteInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface TodoWriteResult {
  count: number;
  todos: Todo[];
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const TodoWriteTool = buildTool<TodoWriteInput, TodoWriteResult>({
  id: BuiltinTools.TodoWrite.id,
  name: BuiltinTools.TodoWrite.name,
  description: `Manage the agent's structured task list for the current agent run.

Always pass the COMPLETE list - previous todos are fully replaced on each call.
Call this at the start of a task to plan, after each step to mark progress, and at the end to confirm all tasks completed.

Status values: \`pending\` | \`in_progress\` | \`completed\` | \`cancelled\`
Priority values: \`high\` | \`medium\` | \`low\``,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  permissionMeta: {
    riskLevel: 'low',
    accessType: 'write',
  },

  async execute(input: TodoWriteInput, ctx: ToolExecutionContext): Promise<TodoWriteResult> {
    const { todos } = input;
    store.set(ctx.turnId, todos);

    // emit 一个 system_warning 作为轻量"todos 已更新"信号,前端无需
    // 专用事件类型即可显示进度。
    const completedCount = todos.filter((t) => t.status === 'completed').length;
    const totalCount = todos.length;
    const msg = `[${completedCount}/${totalCount} completed] ${todos.map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '->' : '·'} ${t.content}`).join(' | ')}`;

    ctx.emit?.({
      type: 'system_warning',
      level: 'info',
      message: msg,
    } satisfies EmaStreamEvent);

    return { count: todos.length, todos };
  },
});
