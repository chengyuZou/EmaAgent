// TodoWrite 只保存当前根 Turn 的完整执行清单，不依赖 TaskStore 或其他宿主能力。
import { describe, expect, it } from 'vitest';
import type { ToolInvocation } from '@ema-agent/tools';
import { BuiltinTools } from '../BuiltinToolIdentity.js';
import { TodoWriteTool } from '../tools/TodoWriteTool/TodoWriteTool.js';

const invocation: ToolInvocation = {
  sessionId: 'session-todo',
  turnId: 'turn-todo',
  toolCallId: 'call-todo',
  signal: new AbortController().signal,
};

const todos = [
  { content: 'Inspect the code', activeForm: 'Inspecting the code', status: 'completed' as const },
  { content: 'Implement the change', activeForm: 'Implementing the change', status: 'in_progress' as const },
  { content: 'Run tests', activeForm: 'Running tests', status: 'pending' as const },
];

describe('TodoWriteTool', () => {
  it('使用 tools 包的稳定身份，不需要任何宿主能力', () => {
    expect(TodoWriteTool.id).toBe(BuiltinTools.TodoWrite.id);
    expect(TodoWriteTool.name).toBe(BuiltinTools.TodoWrite.name);
    expect(TodoWriteTool.validateContext({} as never)).toEqual({
      valid: true,
      context: undefined,
    });
  });

  it('接受完整清单并只返回模型确认文本', async () => {
    const parsed = TodoWriteTool.inputSchema.parse({ todos });
    const result = await TodoWriteTool.execute(parsed, undefined, invocation);

    expect(result).toEqual({
      message: 'Todo list updated. Continue with the current work if applicable.',
    });
    expect(TodoWriteTool.mapResultToModelContent!(result)).toBe(result.message);
  });

  it('拒绝同时存在两个 in_progress 项', () => {
    const parsed = TodoWriteTool.inputSchema.safeParse({
      todos: [
        ...todos,
        { content: 'Write docs', activeForm: 'Writing docs', status: 'in_progress' },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it('允许初始全 pending、最终全 completed 和清空清单', () => {
    expect(TodoWriteTool.inputSchema.safeParse({
      todos: todos.map((todo) => ({ ...todo, status: 'pending' })),
    }).success).toBe(true);
    expect(TodoWriteTool.inputSchema.safeParse({
      todos: todos.map((todo) => ({ ...todo, status: 'completed' })),
    }).success).toBe(true);
    expect(TodoWriteTool.inputSchema.safeParse({ todos: [] }).success).toBe(true);
  });

  it('内置清单更新无需权限弹窗，且调度为有序串行', async () => {
    await expect(TodoWriteTool.checkPermissions(
      { todos },
      undefined,
      {} as never,
    )).resolves.toEqual({ behavior: 'allow' });
    expect(TodoWriteTool.isReadOnly({ todos })).toBe(false);
    expect(TodoWriteTool.isConcurrencySafe({ todos })).toBe(false);
  });
});
