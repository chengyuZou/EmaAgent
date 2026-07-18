// 这里测试父 Turn 收口时后台 Subagent 的取消、等待和 Todo 清理。
import { describe, expect, it } from 'vitest';
import { HookBus } from '@ema-agent/hook';
import { TodoWriteTool, getTodos } from '@ema-agent/tool-builtin';
import type { ToolExecutionContext } from '@ema-agent/tools';
import { SubagentSpawner } from '../src/spawner.js';
import type { AgentDeps } from '../src/types.js';

describe('SubagentSpawner 生命周期', () => {
  it('shutdown 等待后台任务结束并清理其 Todo', async () => {
    const cancelled: string[] = [];
    const llm = {
      stream: async function* ({ signal }: { signal: AbortSignal }) {
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        }
        yield { type: 'done', stopReason: 'end_turn' };
      },
    };
    const deps: AgentDeps = {
      session: {} as never,
      turnLifecycle: {
        complete: () => undefined,
        fail: () => undefined,
        abort: () => undefined,
      },
      hooks: new HookBus(),
      llm: llm as never,
      emotion: {} as never,
      tools: { list: () => [] } as never,
      permission: {} as never,
      taskStore: {
        claim: () => undefined,
        complete: () => undefined,
        fail: () => undefined,
        cancel: (taskId: string, reason: string) => cancelled.push(`${taskId}:${reason}`),
        waitUser: () => ({ ok: true }),
        userAnswered: () => ({ ok: true }),
      },
    };
    const spawner = new SubagentSpawner(
      deps,
      'session-1',
      'turn-1',
      'provider-1',
      'model-1',
      [],
    );
    const subagentId = '11111111-1111-4111-8111-111111111111';
    const parentSignal = new AbortController().signal;

    spawner.spawnBackground('wait until cancelled', { subagentId }, parentSignal);
    await TodoWriteTool.execute({
      todos: [{ id: 'todo-1', content: 'temporary', status: 'pending', priority: 'medium' }],
    }, {
      sessionId: 'session-1',
      turnId: subagentId,
      workspaceRoot: null,
      signal: parentSignal,
    } as ToolExecutionContext);
    expect(getTodos(subagentId)).toHaveLength(1);

    await spawner.shutdown('parent_turn_finished');

    expect(getTodos(subagentId)).toEqual([]);
    expect(cancelled).toContain(`${subagentId}:parent_turn_finished`);
    await expect(spawner.awaitBackground(subagentId)).resolves.toBeNull();
  });
});
