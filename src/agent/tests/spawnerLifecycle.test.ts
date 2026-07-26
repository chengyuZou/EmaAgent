// 测试父 Turn 收口时后台 AgentRun 会被取消、等待并清理运行时句柄。

import { describe, expect, it } from 'vitest';
import { asAgentRunId } from '@ema-agent/ids';
import { HookBus } from '@ema-agent/hooks';
import { ToolRegistry } from '@ema-agent/tools';
import { SubagentSpawner } from '../spawner.js';
import type { SubagentSpawnerDeps } from '../spawner.js';

describe('SubagentSpawner 生命周期', () => {
  it('shutdown 等待后台执行并记录 AgentRun 取消终态', async () => {
    const cancelled: string[] = [];
    const llm = {
      stream: async function* ({ signal }: { signal: AbortSignal }) {
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        yield { type: 'done', stopReason: 'end_turn' };
      },
    };
    const deps: SubagentSpawnerDeps = {
      session: {} as never,
      hooks: new HookBus(),
      llm: llm as never,
      modelCapabilities: {
        resolve: () => ({
          input: { text: 'supported', image: 'unknown', audio: 'unknown', file: 'unknown' },
          tools: 'unknown',
          reasoning: 'unknown',
          temperature: 'unknown',
          source: 'unknown',
        }),
      },
      emotion: {} as never,
      tools: new ToolRegistry(),
      permission: {} as never,
      agentRunStore: {
        start: input => ({
          id: input.agentRunId,
          sessionId: input.sessionId,
          parentTurnId: input.parentTurnId,
          kind: input.kind,
          status: 'running',
          version: 0,
          createdAt: 1,
          updatedAt: 1,
        }),
        complete: () => ({ ok: false, reason: 'conflict', action: 'complete' }),
        fail: () => ({ ok: false, reason: 'conflict', action: 'fail' }),
        cancel: (agentRunId, reason) => {
          cancelled.push(`${agentRunId}:${reason}`);
          return { ok: false, reason: 'conflict', action: 'cancel' };
        },
      },
    };
    const spawner = new SubagentSpawner(
      deps,
      'session-1',
      'turn-1',
      'provider-1',
      'model-1',
      [],
      '',
      undefined,
      new Map(),
    );
    const agentRunId = asAgentRunId('11111111-1111-4111-8111-111111111111');
    const parentSignal = new AbortController().signal;

    spawner.spawnBackground('wait until cancelled', { agentRunId }, parentSignal);
    await spawner.shutdown('parent_turn_finished');

    expect(cancelled).toContain(`${agentRunId}:parent_turn_finished`);
    await expect(spawner.awaitBackground(agentRunId)).resolves.toBeNull();
  });
});
