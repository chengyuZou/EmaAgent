// 测试流式 Runtime 只负责调度，并按模型 block 顺序发射并发工具终态。

import { describe, expect, it } from 'vitest';
import type { SessionId, TurnId } from '@ema-agent/ids';
import {
  createToolManifestSnapshot,
  ToolExecutionRuntime,
  type ExecutableToolManifestSnapshot,
  type ToolExecutionRuntimeEvent,
} from '../index.js';

const sessionId = 'session-runtime-fifo' as SessionId;
const turnId = 'turn-runtime-fifo' as TurnId;

describe('ToolExecutionRuntime', () => {
  it('并发工具完成顺序相反时仍按模型出现顺序发射 tool_result', async () => {
    const completions = new Map<string, () => void>();
    const emitted: ToolExecutionRuntimeEvent[] = [];
    const manifest = createToolManifestSnapshot([], 1) as ExecutableToolManifestSnapshot;
    const executor = new ToolExecutionRuntime({
      sessionId,
      turnId,
      allows: () => true,
      toolManifest: manifest,
      tools: {
        prepare: (name: string, input: unknown) => ({
          id: `builtin.${name.toLowerCase()}`,
          name,
          origin: { kind: 'builtin' },
          input,
          isReadOnly: true,
          isConcurrencySafe: true,
          requiresUserInteraction: false,
          maxResultBytes: 1024,
        }),
        validateContext: () => ({ valid: true, context: {} }),
        validate: async () => ({ valid: true }),
        permissionIntent: async () => ({
          riskLevel: 'low',
          accessType: 'read',
          promptPolicy: 'neverForTrustedBuiltin',
        }),
        execute: async (prepared: { name: string }) => {
          await new Promise<void>(resolve => completions.set(prepared.name, resolve));
          return prepared.name;
        },
      } as never,
      permission: { authorize: async () => ({ outcome: 'allow' }) } as never,
      permCtx: { mode: 'default' },
      toolContext: { signal: new AbortController().signal },
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
