import { describe, expect, it } from 'vitest';
import type { EmaStreamEvent, SessionId, TurnId } from '@ema-agent/contracts';
import { HookBus } from '@ema-agent/hook';
import { ToolInputError } from '@ema-agent/tools';
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

  const failureCases = [
    {
      name: '策略拒绝',
      allows: false,
      hasTool: true,
      args: {},
      expected: { phase: 'policy', code: 'policy/denied', retryable: false },
    },
    {
      name: '未知工具',
      allows: true,
      hasTool: false,
      args: {},
      expected: { phase: 'validation', code: 'tool/not_found', retryable: true },
    },
    {
      name: '参数 JSON 解析失败',
      allows: true,
      hasTool: true,
      args: { __parse_error: true, raw: '{"path":' },
      expected: { phase: 'validation', code: 'tool/args_parse_error', retryable: true },
    },
    {
      name: '权限拒绝',
      allows: true,
      hasTool: true,
      args: {},
      permissionDenied: true,
      expected: { phase: 'permission', code: 'permission/denied', retryable: false },
    },
    {
      name: 'Schema 校验失败',
      allows: true,
      hasTool: true,
      args: {},
      dispatchError: makeToolInputError(),
      expected: { phase: 'validation', code: 'tool/validation_failed', retryable: true },
    },
    {
      name: '工具执行失败',
      allows: true,
      hasTool: true,
      args: {},
      dispatchError: new Error('disk unavailable'),
      expected: { phase: 'execution', code: 'tool/error', retryable: false },
    },
  ] as const;

  for (const failureCase of failureCases) {
    it(`结构化上报${failureCase.name}`, async () => {
      const hooks = new HookBus();
      const lifecycle: Array<{
        event: 'before' | 'failure';
        callId: string;
        phase?: string;
        code?: string;
        retryable?: boolean;
      }> = [];
      const emitted: EmaStreamEvent[] = [];

      hooks.register('beforeToolUse', (ctx) => {
        lifecycle.push({ event: 'before', callId: ctx.payload.callId });
        return { kind: 'continue' };
      });
      hooks.register('onToolFailure', (ctx) => {
        lifecycle.push({
          event: 'failure',
          callId: ctx.payload.callId,
          phase: ctx.payload.phase,
          code: ctx.payload.code,
          retryable: ctx.payload.retryable,
        });
        return { kind: 'continue' };
      });

      const tools = {
        has: () => failureCase.hasTool,
        get: () => ({
          isConcurrencySafe: () => true,
          permissionMeta: {},
        }),
        dispatch: async () => {
          if ('dispatchError' in failureCase) throw failureCase.dispatchError;
          return 'ok';
        },
      };
      const permission = {
        gate: async () => 'permissionDenied' in failureCase
          ? { granted: false, reason: 'user denied' }
          : { granted: true },
      };
      const turnAbort = new AbortController();
      const executor = new TurnToolExecutor({
        sessionId,
        turnId,
        allows: () => failureCase.allows,
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
      });

      executor.addTool(0, 'call-failure', 'test_tool', failureCase.args);
      await waitUntilDone(executor);

      expect(lifecycle).toEqual([
        { event: 'before', callId: 'call-failure' },
        { event: 'failure', callId: 'call-failure', ...failureCase.expected },
      ]);
      expect(emitted).toContainEqual(expect.objectContaining({
        type: 'tool_result',
        callId: 'call-failure',
        name: 'test_tool',
        error: expect.objectContaining({ code: failureCase.expected.code }),
      }));
    });
  }

  it('单工具取消不误报 onToolFailure', async () => {
    const hooks = new HookBus();
    const failures: unknown[] = [];
    const emitted: EmaStreamEvent[] = [];
    hooks.register('onToolFailure', (ctx) => {
      failures.push(ctx.payload);
      return { kind: 'continue' };
    });

    const turnAbort = new AbortController();
    const executor = new TurnToolExecutor({
      sessionId,
      turnId,
      allows: () => true,
      tools: {
        has: () => true,
        get: () => ({ isConcurrencySafe: () => true, permissionMeta: {} }),
        dispatch: async (_name: string, _args: unknown, ctx: { signal: AbortSignal }) =>
          await new Promise((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      } as never,
      permission: { gate: async () => ({ granted: true }) } as never,
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
    });

    executor.addTool(0, 'call-cancel', 'long_running_tool', {});
    while (!executor.abortTool('call-cancel')) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    await waitUntilDone(executor);

    expect(failures).toEqual([]);
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      callId: 'call-cancel',
      output: '[用户中途终止]',
    }));
    expect(executor.getResults()[0]).toEqual(expect.objectContaining({
      toolUseId: 'call-cancel',
      isError: false,
    }));
  });
});

function makeToolInputError(): ToolInputError {
  const error = new Error('Invalid input for tool "test_tool"') as ToolInputError;
  Object.setPrototypeOf(error, ToolInputError.prototype);
  return error;
}
