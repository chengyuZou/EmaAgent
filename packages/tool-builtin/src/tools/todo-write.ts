import { z } from 'zod';
import { buildTool } from '@ema-agent/tool';
import type { ToolExecutionContext } from '@ema-agent/tool';
import type { EmaStreamEvent } from '@ema-agent/contracts';

// ── Types ─────────────────────────────────────────────────────────────────────

const todoStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);

const todoSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: todoStatusSchema,
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
});

export type Todo = z.infer<typeof todoSchema>;

// ── In-memory store (per-process, keyed by sessionId) ─────────────────────────
// AgentEngine resets this at the start of each agent run by calling clearTodos().

const store = new Map<string, Todo[]>();

export function getTodos(sessionId: string): Todo[] {
  return store.get(sessionId) ?? [];
}

export function clearTodos(sessionId: string): void {
  store.delete(sessionId);
}

// ── Input schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  todos: z
    .array(todoSchema)
    .describe(
      'Complete replacement list of todos. The entire previous list is replaced on each call.',
    ),
});

type TodoWriteInput = z.infer<typeof inputSchema>;

// ── Output type ───────────────────────────────────────────────────────────────

export interface TodoWriteResult {
  count: number;
  todos: Todo[];
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const todoWriteTool = buildTool<TodoWriteInput, TodoWriteResult>({
  name: 'todo_write',
  description: `Manage the agent's structured task list for the current agent run.

Always pass the COMPLETE list — previous todos are fully replaced on each call.
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
    store.set(ctx.sessionId, todos);

    // Emit a system_warning as a lightweight "todos updated" signal so the
    // frontend can display progress without a dedicated event type.
    const completedCount = todos.filter((t) => t.status === 'completed').length;
    const totalCount = todos.length;
    const msg = `[${completedCount}/${totalCount} completed] ${todos.map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '·'} ${t.content}`).join(' | ')}`;

    ctx.emit?.({
      type: 'system_warning',
      level: 'info',
      message: msg,
    } satisfies EmaStreamEvent);

    return { count: todos.length, todos };
  },
});
