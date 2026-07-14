import { describe, expect, it } from 'vitest';
import type { EmaStreamEvent, SessionId, TurnId } from '@ema-agent/contracts';
import { HookBus } from '@ema-agent/hook';
import { TurnToolExecutor, type TurnToolExecutorOpts } from '../src/tool-executor.js';

const sessionId = 'session-order' as SessionId;
const turnId = 'turn-order' as TurnId;

async function waitUntilDone(executor: TurnToolExecutor): Promise<void> {
  while (!executor.allDone()) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe('TurnToolExecutor Hook 与权限边界', () => {
  it('固定按工具意图 Hook、PermissionEngine、工具执行的顺序运行', async () => {
    const order: string[] = [];
    const emitted: EmaStreamEvent[] = [];
    const hooks = new HookBus();

    hooks.register('beforeToolUse', () => {
      order.push('beforeToolUse');
      return { kind: 'continue' };
    }, { name: 'test:intent-observer' });

    const tools = {
      has: () => true,
      get: () => ({
        isConcurrencySafe: () => true,
        permissionMeta: {},
      }),
      dispatch: async () => {
        order.push('dispatch');
        return 'ok';
      },
    };
    const permission = {
      gate: async () => {
        order.push('permission');
        return { granted: true };
      },
    };
    const turnAbort = new AbortController();

    const opts: TurnToolExecutorOpts = {
      sessionId,
      turnId,
      allows: () => true,
      tools: tools as never,
      permission: permission as never,
      permCtx: { workspaceRoot: null, sessionId } as never,
      hooks,
      toolCtx: {
        sessionId,
        turnId,
        workspaceRoot: null,
        signal: turnAbort.signal,
      } as never,
      pushEv: (event) => emitted.push(event),
      signal: () => undefined,
    };

    const executor = new TurnToolExecutor(opts);
    executor.addTool(0, 'call-1', 'read_file', { path: 'README.md' });
    await waitUntilDone(executor);

    expect(order).toEqual(['beforeToolUse', 'permission', 'dispatch']);
    expect(emitted.at(-1)).toEqual(expect.objectContaining({
      type: 'tool_result',
      callId: 'call-1',
      name: 'read_file',
      output: 'ok',
    }));
  });
});
