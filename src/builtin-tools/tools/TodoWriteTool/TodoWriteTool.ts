// 当前根 Turn 的执行清单。完整清单保存在 tool_use input 中，不另建 SQL 或内存状态。
import { z } from 'zod';
import { buildTool, contextOk } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { TODO_WRITE_DESCRIPTION } from './prompt.js';

const todoItemSchema = z.object({
  content: z.string().trim().min(1).max(500).describe(
    'Imperative description of the work, for example "Run focused tests".',
  ),
  activeForm: z.string().trim().min(1).max(500).describe(
    'Present continuous description shown while running, for example "Running focused tests".',
  ),
  status: z.enum(['pending', 'in_progress', 'completed']),
}).strict();

const inputSchema = z.object({
  todos: z.array(todoItemSchema).max(100).describe(
    'The complete replacement checklist for the current root Turn.',
  ),
}).strict().superRefine((input, refinement) => {
  const activeCount = input.todos.filter((todo) => todo.status === 'in_progress').length;
  if (activeCount > 1) {
    refinement.addIssue({
      code: 'custom',
      path: ['todos'],
      message: 'At most one todo may be in_progress.',
    });
  }
});

export type TodoItem = z.infer<typeof todoItemSchema>;
export type TodoWriteInput = z.infer<typeof inputSchema>;

export interface TodoWriteResult {
  message: string;
}

export const TodoWriteTool = buildTool<TodoWriteInput, TodoWriteResult, undefined>({
  id: BuiltinTools.TodoWrite.id,
  name: BuiltinTools.TodoWrite.name,
  description: TODO_WRITE_DESCRIPTION,
  inputSchema,
  maxResultBytes: 1_024,

  // 清单更新必须按模型输出顺序执行，不能与同批业务工具并发穿插。
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  checkPermissions: async () => ({ behavior: 'allow' }),
  getToolUseSummary: (input) => `更新当前执行清单，共 ${input.todos.length} 项`,

  // TODO 不需要宿主能力；子 Agent 的不可见性由父 ToolPool 的显式收窄保证。
  validateContext() {
    return contextOk(undefined);
  },

  async execute(): Promise<TodoWriteResult> {
    return { message: 'Todo list updated. Continue with the current work if applicable.' };
  },

  mapResultToModelContent(output) {
    return output.message;
  },
});
