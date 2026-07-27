// 测试单个 Turn 内工具调用的准备、权限、执行、等待用户和终态收口。
import { describe, expect, it, vi } from 'vitest';
import type { SessionId, TurnId } from '@ema-agent/ids';
import type { AgentExecutionEvent } from '../events.js';
import { HookBus } from '@ema-agent/hooks';
import {
  ToolExecutionRuntime,
  ToolInputError,
  type ToolExecutionRuntimeOptions,
} from '@ema-agent/tools';
import { createToolLifecycleHooks } from '../toolLifecycleHooks.js';

const sessionId = 'session-order' as SessionId;
const turnId = 'turn-order' as TurnId;

async function waitUntilDone(executor: ToolExecutionRuntime): Promise<void> {
  while (!executor.allDone()) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe('ToolExecutionRuntime Hook 与权限边界', () => {
  it('四种询问用户工具都会让 Turn 保持 waiting_user', () => {
    const hooks = new HookBus();
    const makeExecutor = (): ToolExecutionRuntime => new ToolExecutionRuntime({
      sessionId,
      turnId,
      allows: () => true,
      tools: {
        has: () => true,
        prepare: (name: string, input: unknown) => ({
          id: name,
          name,
          origin: { kind: 'builtin' },
          input,
          isReadOnly: false,
          isConcurrencySafe: false,
          requiresUserInteraction: ['AskUser', 'AskText', 'AskChoice', 'AskConfirm'].includes(name),
          maxResultBytes: 1024,
          permissionMeta: {},
        }),
        validate: async () => ({ valid: true }),
        validateContext: () => ({ valid: true, context: {} }),
        execute: async () => 'ok',
      } as never,
      permission: {} as never,
      permCtx: { workspaceRoot: null } as never,
      lifecycle: createToolLifecycleHooks(hooks, () => undefined),
      toolContext: {
        sessionId,
        turnId,
        workspaceRoot: null,
        signal: new AbortController().signal,
      } as never,
      pushEv: () => undefined,
      signal: () => undefined,
    });

    for (const name of ['AskUser', 'AskText', 'AskChoice', 'AskConfirm']) {
      const executor = makeExecutor();
      executor.addTool(0, `call-${name}`, name, {});
      expect(executor.hasWaitingUserTool()).toBe(true);
    }

    const executor = makeExecutor();
    executor.addTool(0, 'call-Bash', 'Bash', {});
    expect(executor.hasWaitingUserTool()).toBe(false);
  });

  it('把 Session、Turn、ToolCall 身份传给同一次权限审批', async () => {
    const hooks = new HookBus();
    let gateContext: unknown;
    let askIdentity: unknown;
    const executor = new ToolExecutionRuntime({
      sessionId,
      turnId,
      allows: () => true,
      tools: {
        has: () => true,
        prepare: (name: string, input: unknown) => ({
          name,
          input,
          isReadOnly: true,
          isConcurrencySafe: true,
          permissionMeta: {},
        }),
        validateContext: () => ({ valid: true, context: {} }),
        execute: async () => 'ok',
      } as never,
      permission: {
        gate: async (_name: string, _input: unknown, _meta: unknown, context: unknown) => {
          gateContext = context;
          return { granted: true };
        },
      } as never,
      permCtx: { workspaceRoot: null } as never,
      lifecycle: createToolLifecycleHooks(hooks, () => undefined),
      toolContext: {
        sessionId,
        turnId,
        workspaceRoot: null,
        signal: new AbortController().signal,
      } as never,
      buildAsk: (identity) => {
        askIdentity = identity;
        return async () => ({ action: 'allow' });
      },
      pushEv: () => undefined,
      signal: () => undefined,
    });

    executor.addTool(0, 'call-identity', 'Read', { path: 'README.md' });
    await waitUntilDone(executor);

    expect(askIdentity).toEqual(expect.objectContaining({
      sessionId,
      turnId,
      toolCallId: 'call-identity',
    }));
    expect(gateContext).toEqual(expect.objectContaining({
      sessionId,
      turnId,
      toolCallId: 'call-identity',
      ask: expect.any(Function),
    }));
  });

  it('固定按工具意图 Hook、PermissionEngine、工具执行的顺序运行', async () => {
    const order: string[] = [];
    const emitted: AgentExecutionEvent[] = [];
    let approvedInput: unknown;
    const hooks = new HookBus();

    hooks.register('beforeToolUse', () => {
      order.push('beforeToolUse');
      return { kind: 'continue' };
    }, { name: 'test:intent-observer' });

    const tools = {
      has: () => true,
      prepare: (name: string, input: unknown) => ({
        name,
        input,
        isReadOnly: true,
        isConcurrencySafe: true,
        permissionMeta: {},
      }),
      validateContext: () => ({ valid: true, context: {} }),
      execute: async (prepared: { input: unknown }) => {
        expect(prepared.input).toBe(approvedInput);
        order.push('dispatch');
        return 'ok';
      },
    };
    const permission = {
      gate: async (_name: string, input: unknown) => {
        approvedInput = input;
        order.push('permission');
        return { granted: true };
      },
    };
    const toolExecutionJournal = {
      prepare: () => order.push('journal:prepared'),
      authorize: () => order.push('journal:authorized'),
      start: () => order.push('journal:running'),
      succeed: () => order.push('journal:succeeded'),
      fail: () => order.push('journal:failed'),
      cancel: () => order.push('journal:cancelled'),
      outcomeUnknown: () => order.push('journal:outcome_unknown'),
    };
    const turnAbort = new AbortController();

    const opts: ToolExecutionRuntimeOptions = {
      sessionId,
      turnId,
      allows: () => true,
      tools: tools as never,
      permission: permission as never,
      permCtx: { workspaceRoot: null, sessionId } as never,
      lifecycle: createToolLifecycleHooks(hooks, (event) => emitted.push(event)),
      toolContext: {
        sessionId,
        turnId,
        workspaceRoot: null,
        signal: turnAbort.signal,
      } as never,
      pushEv: (event) => emitted.push(event),
      signal: () => undefined,
      toolExecutionJournal,
    };

    const executor = new ToolExecutionRuntime(opts);
    executor.addTool(0, 'call-1', 'Read', { path: 'README.md' });
    await waitUntilDone(executor);

    expect(order).toEqual([
      'journal:prepared',
      'beforeToolUse',
      'permission',
      'journal:authorized',
      'journal:running',
      'dispatch',
      'journal:succeeded',
    ]);
    expect(emitted.at(-1)).toEqual(expect.objectContaining({
      type: 'tool_result',
      callId: 'call-1',
      name: 'Read',
      output: 'ok',
    }));
  });

  it('显式 not_required 的可信工具跳过普通审批但仍执行完整工具主链', async () => {
    const gate = vi.fn(async () => ({ granted: false }));
    const execute = vi.fn(async () => 'answered');
    const executor = new ToolExecutionRuntime({
      sessionId,
      turnId,
      allows: () => true,
      tools: {
        has: () => true,
        prepare: (name: string, input: unknown) => ({
          id: name,
          name,
          origin: { kind: 'builtin' },
          input,
          isReadOnly: false,
          isConcurrencySafe: false,
          requiresUserInteraction: true,
          maxResultBytes: 1024,
          permissionMeta: {
            approval: 'not_required',
            riskLevel: 'low',
          },
        }),
        validate: async () => ({ valid: true }),
        validateContext: () => ({ valid: true, context: {} }),
        execute,
      } as never,
      permission: { gate } as never,
      permCtx: { workspaceRoot: null } as never,
      lifecycle: createToolLifecycleHooks(new HookBus(), () => undefined),
      toolContext: {
        sessionId,
        turnId,
        workspaceRoot: null,
        signal: new AbortController().signal,
      } as never,
      pushEv: () => undefined,
      signal: () => undefined,
    });

    executor.addTool(0, 'call-ask', 'AskText', { question: '继续吗？' });
    await waitUntilDone(executor);

    expect(gate).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('非内置 PreparedToolCall 即使伪造 not_required 仍必须经过审批', async () => {
    const gate = vi.fn(async () => ({ granted: false, reason: 'denied' }));
    const execute = vi.fn(async () => 'should not run');
    const executor = new ToolExecutionRuntime({
      sessionId,
      turnId,
      allows: () => true,
      tools: {
        has: () => true,
        prepare: (name: string, input: unknown) => ({
          id: name,
          name,
          origin: { kind: 'mcp', serverName: 'remote', serverToolName: name },
          input,
          isReadOnly: false,
          isConcurrencySafe: false,
          requiresUserInteraction: false,
          maxResultBytes: 1024,
          permissionMeta: {
            approval: 'not_required',
            riskLevel: 'low',
          },
        }),
        validate: async () => ({ valid: true }),
        validateContext: () => ({ valid: true, context: {} }),
        execute,
      } as never,
      permission: { gate } as never,
      permCtx: { workspaceRoot: null } as never,
      lifecycle: createToolLifecycleHooks(new HookBus(), () => undefined),
      toolContext: {
        sessionId,
        turnId,
        workspaceRoot: null,
        signal: new AbortController().signal,
      } as never,
      pushEv: () => undefined,
      signal: () => undefined,
    });

    executor.addTool(0, 'call-mcp', 'remote_tool', {});
    await waitUntilDone(executor);

    expect(gate).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
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
      preparationError: makeToolInputError(),
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
      const emitted: AgentExecutionEvent[] = [];

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
        prepare: (name: string, input: unknown) => {
          if ('preparationError' in failureCase) throw failureCase.preparationError;
          return {
            name,
            input,
            isReadOnly: true,
            isConcurrencySafe: true,
            permissionMeta: {},
          };
        },
        validateContext: () => ({ valid: true, context: {} }),
        execute: async () => {
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
      const executor = new ToolExecutionRuntime({
        sessionId,
        turnId,
        allows: () => failureCase.allows,
        tools: tools as never,
        permission: permission as never,
        permCtx: { workspaceRoot: null, sessionId } as never,
        lifecycle: createToolLifecycleHooks(hooks, (event) => emitted.push(event)),
        toolContext: {
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
    const emitted: AgentExecutionEvent[] = [];
    hooks.register('onToolFailure', (ctx) => {
      failures.push(ctx.payload);
      return { kind: 'continue' };
    });

    const turnAbort = new AbortController();
    const executor = new ToolExecutionRuntime({
      sessionId,
      turnId,
      allows: () => true,
      tools: {
        has: () => true,
        prepare: (name: string, input: unknown) => ({
          name,
          input,
          isReadOnly: true,
          isConcurrencySafe: true,
          permissionMeta: {},
        }),
        validateContext: (_p: unknown, ctx: { signal: AbortSignal }) => ({ valid: true, context: { signal: ctx.signal } }),
        execute: async (_prepared: unknown, ctx: { signal: AbortSignal }) =>
          await new Promise((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      } as never,
      permission: { gate: async () => ({ granted: true }) } as never,
      permCtx: { workspaceRoot: null, sessionId } as never,
      lifecycle: createToolLifecycleHooks(hooks, (event) => emitted.push(event)),
      toolContext: {
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

  it('Turn 终止时先取消并等待 running 工具', async () => {
    const hooks = new HookBus();
    const journalStates: string[] = [];
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const turnAbort = new AbortController();
    const executor = new ToolExecutionRuntime({
      sessionId,
      turnId,
      allows: () => true,
      tools: {
        has: () => true,
        prepare: (name: string, input: unknown) => ({
          name,
          input,
          isReadOnly: false,
          isConcurrencySafe: true,
          permissionMeta: {},
        }),
        validateContext: (_p: unknown, ctx: { signal: AbortSignal }) => ({ valid: true, context: { signal: ctx.signal } }),
        execute: async (_prepared: unknown, ctx: { signal: AbortSignal }) => {
          notifyStarted();
          return await new Promise((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
      } as never,
      permission: { gate: async () => ({ granted: true }) } as never,
      permCtx: { workspaceRoot: null, sessionId } as never,
      lifecycle: createToolLifecycleHooks(hooks, () => undefined),
      toolContext: {
        sessionId,
        turnId,
        workspaceRoot: null,
        signal: turnAbort.signal,
      } as never,
      pushEv: () => undefined,
      signal: () => undefined,
      toolExecutionJournal: {
        prepare: () => journalStates.push('prepared'),
        authorize: () => journalStates.push('authorized'),
        start: () => journalStates.push('running'),
        succeed: () => journalStates.push('succeeded'),
        fail: () => journalStates.push('failed'),
        cancel: () => journalStates.push('cancelled'),
        outcomeUnknown: () => journalStates.push('outcome_unknown'),
      },
    });

    executor.addTool(0, 'call-shutdown', 'Write', {});
    await started;
    await executor.shutdown('provider_failed');

    expect(executor.allDone()).toBe(true);
    expect(journalStates).toEqual(['prepared', 'authorized', 'running', 'outcome_unknown']);
  });
});

function makeToolInputError(): ToolInputError {
  const error = new Error('Invalid input for tool "test_tool"') as ToolInputError;
  Object.setPrototypeOf(error, ToolInputError.prototype);
  return error;
}
