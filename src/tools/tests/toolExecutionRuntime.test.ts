// 测试流式 Runtime 只负责调度，并按模型 block 顺序发射并发工具终态。

import type { SessionId, TurnId } from '@ema-agent/ids';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolPool } from '../assembly/toolPool.js';
import { ToolExecutionRuntime } from '../execution/toolExecutionRuntime.js';
import { buildTool } from '../Tool/buildTool.js';
import type { ToolExecutionRuntimeEvent } from '../index.js';

const sessionId = 'session-runtime-fifo' as SessionId;
const turnId = 'turn-runtime-fifo' as TurnId;

describe('ToolExecutionRuntime', () => {
  it('并发工具完成顺序相反时仍按模型出现顺序发射 tool_result', async () => {
    const completions = new Map<string, () => void>();
    const emitted: ToolExecutionRuntimeEvent[] = [];
    const makeTool = (name: string) => buildTool({
      id: `builtin.${name.toLowerCase()}`,
      name,
      description: `${name} test tool`,
      inputSchema: z.object({}),
      validateContext: () => ({ valid: true, context: {} }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      getPermissionIntent: () => ({
        riskLevel: 'low',
        accessType: 'read',
        promptPolicy: 'neverForTrustedBuiltin',
      }),
      execute: async () => {
        await new Promise<void>(resolve => completions.set(name, resolve));
        return name;
      },
    });
    const executor = new ToolExecutionRuntime({
      sessionId,
      turnId,
      toolPool: new ToolPool([makeTool('First'), makeTool('Second')]),
      permission: {
        authorize: async () => ({ outcome: 'allow', reason: { type: 'workspace' } }),
        clearSession: () => {},
      },
      permCtx: { mode: 'default' },
      abortSignal: new AbortController().signal,
      toolContext: { workspaceRoot: 'D:/workspace', platform: 'win32' },
      pushEv: event => emitted.push(event),
      signal: () => undefined,
    });

    executor.addTool(0, 'call-first', 'First', {});
    executor.addTool(1, 'call-second', 'Second', {});
    await waitFor(() => completions.size === 2);

    completions.get('Second')!();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(emitted.filter(event => event.type === 'tool_result')).toEqual([]);

    completions.get('First')!();
    await executor.join();

    expect(emitted
      .filter((event): event is Extract<ToolExecutionRuntimeEvent, { type: 'tool_result' }> => (
        event.type === 'tool_result'
      ))
      .map(event => event.callId))
      .toEqual(['call-first', 'call-second']);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  throw new Error('等待测试条件超时');
}
