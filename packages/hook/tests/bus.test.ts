import { describe, it, expect, vi } from 'vitest';
import { HookBus } from '../src/bus.js';
import { PRIORITY } from '../src/priority.js';
import type { HookPayload } from '../src/events.js';
import type { DeepReadonly } from '../src/types.js';
import type { EmaStreamEvent, LlmCallId, MessageId, TurnId, SessionId } from '@ema-agent/contracts';

const turnId = 'turn-1' as TurnId;
const sessionId = 'session-1' as SessionId;
const llmCallId = 'llm-call-1' as LlmCallId;

function baseCtx(signal?: AbortSignal) {
  return { turnId, sessionId, ...(signal ? { signal } : {}) };
}

function beforeLlmPayload(
  overrides: Partial<HookPayload['beforeLlm']> = {},
): HookPayload['beforeLlm'] {
  return {
    iteration: 1,
    llmCallId,
    messages: [{ role: 'system', content: 'base' }],
    mode: 'chat',
    userInput: 'hello',
    providerId: 'provider-1',
    model: 'model-1',
    ...overrides,
  };
}

function afterLlmPayload(content: string): HookPayload['afterLlmComplete'] {
  return { iteration: 1, llmCallId, content };
}

function systemMessageContent(payload: DeepReadonly<HookPayload['beforeLlm']>): string {
  const first = payload.messages[0];
  return first?.role === 'system' && typeof first.content === 'string'
    ? first.content
    : '';
}

function replaceSystemMessage(
  payload: DeepReadonly<HookPayload['beforeLlm']>,
  content: string,
): HookPayload['beforeLlm'] {
  const next = structuredClone(payload) as HookPayload['beforeLlm'];
  const tail = next.messages[0]?.role === 'system'
    ? next.messages.slice(1)
    : next.messages;
  next.messages = [{ role: 'system', content }, ...tail];
  return next;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('HookBus', () => {
  it('runs serial handlers in priority order', async () => {
    const bus = new HookBus();
    const order: number[] = [];

    bus.register(
      'onTurnStart',
      async () => {
        order.push(2);
        return { kind: 'continue' };
      },
      { priority: PRIORITY.EARLY },
    );

    bus.register(
      'onTurnStart',
      async () => {
        order.push(1);
        return { kind: 'continue' };
      },
      { priority: PRIORITY.FIRST },
    );

    bus.register(
      'onTurnStart',
      async () => {
        order.push(3);
        return { kind: 'continue' };
      },
      { priority: PRIORITY.DEFAULT },
    );

    const result = await bus.trigger('onTurnStart', {
      ...baseCtx(),
      payload: { mode: 'chat' },
    });

    expect(order).toEqual([1, 2, 3]);
    expect(result).toEqual({
      kind: 'continue',
      payload: { mode: 'chat' },
      warnings: [],
    });
  });

  it('returns continue with original payload when no handlers are registered', async () => {
    const bus = new HookBus();

    const result = await bus.trigger('onTurnAbort', {
      ...baseCtx(),
      payload: { reason: 'user_stop' },
    });

    expect(result).toEqual({
      kind: 'continue',
      payload: { reason: 'user_stop' },
      warnings: [],
    });
  });

  it('stops chain when a handler returns abort', async () => {
    const bus = new HookBus();
    const reached = vi.fn();

    bus.register(
      'onTurnStart',
      async () => ({ kind: 'abort', reason: 'test' }),
      { priority: PRIORITY.FIRST },
    );

    bus.register('onTurnStart', async () => {
      reached();
      return { kind: 'continue' };
    });

    const result = await bus.trigger('onTurnStart', {
      ...baseCtx(),
      payload: { mode: 'chat' },
    });

    expect(result).toEqual({
      kind: 'abort',
      reason: 'test',
      payload: { mode: 'chat' },
      warnings: [],
    });

    expect(reached).not.toHaveBeenCalled();
  });

  it('treats thrown error from critical hook as abort', async () => {
    const bus = new HookBus();

    bus.register('onTurnStart', async () => {
      throw new Error('boom');
    });

    const result = await bus.trigger('onTurnStart', {
      ...baseCtx(),
      payload: { mode: 'chat' },
    });

    expect(result).toEqual({
      kind: 'abort',
      reason: 'boom',
      payload: { mode: 'chat' },
      warnings: [],
    });
  });

  it('continues and records warning when non-critical hook throws', async () => {
    const bus = new HookBus();
    const reached = vi.fn();

    bus.register(
      'afterLlmComplete',
      async () => {
        throw new Error('telemetry failed');
      },
      {
        name: 'telemetry',
        critical: false,
      },
    );

    bus.register('afterLlmComplete', async () => {
      reached();
      return { kind: 'continue' };
    });

    const result = await bus.trigger('afterLlmComplete', {
      ...baseCtx(),
      payload: afterLlmPayload('hello'),
    });

    expect(reached).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      kind: 'continue',
      payload: afterLlmPayload('hello'),
      warnings: [
        {
          event: 'afterLlmComplete',
          hook: 'telemetry',
          reason: 'telemetry failed',
        },
      ],
    });
  });

  it('unregisters handler', async () => {
    const bus = new HookBus();
    const handler = vi.fn(async () => ({ kind: 'continue' as const }));

    const unregister = bus.register('onTurnEnd', handler);
    unregister();

    const result = await bus.trigger('onTurnEnd', {
      ...baseCtx(),
      payload: { durationMs: 100 },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: 'continue',
      payload: { durationMs: 100 },
      warnings: [],
    });
  });

  it('serial replace updates payload for subsequent handlers', async () => {
    const bus = new HookBus();
    let seen = '';
    let handlerInputFrozen = false;

    bus.register(
      'beforeLlm',
      async (ctx) => {
        handlerInputFrozen = Object.isFrozen(ctx.payload)
          && Object.isFrozen(ctx.payload.messages);
        return {
          kind: 'replace',
          payload: replaceSystemMessage(ctx.payload, 'new-system'),
        };
      },
      { priority: PRIORITY.FIRST },
    );

    bus.register('beforeLlm', async (ctx) => {
      seen = systemMessageContent(ctx.payload);
      return { kind: 'continue' };
    });

    const source = beforeLlmPayload({ messages: [{ role: 'system', content: 'old-system' }] });
    const result = await bus.trigger('beforeLlm', {
      ...baseCtx(),
      payload: source,
    });

    expect(seen).toBe('new-system');
    expect(handlerInputFrozen).toBe(true);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(source.messages)).toBe(false);
    expect(Object.isFrozen(result.payload)).toBe(false);
    expect(Object.isFrozen(result.payload.messages)).toBe(false);
    expect(systemMessageContent(source)).toBe('old-system');
    expect(result).toEqual({
      kind: 'continue',
      payload: beforeLlmPayload({ messages: [{ role: 'system', content: 'new-system' }] }),
      warnings: [],
    });
  });

  it('serial multiple replace returns final payload', async () => {
    const bus = new HookBus();

    bus.register(
      'beforeLlm',
      async (ctx) => ({
        kind: 'replace',
        payload: replaceSystemMessage(
          ctx.payload,
          `${systemMessageContent(ctx.payload)} + memory`,
        ),
      }),
      { priority: 10 },
    );

    bus.register(
      'beforeLlm',
      async (ctx) => ({
        kind: 'replace',
        payload: replaceSystemMessage(
          ctx.payload,
          `${systemMessageContent(ctx.payload)} + persona`,
        ),
      }),
      { priority: 20 },
    );

    const result = await bus.trigger('beforeLlm', {
      ...baseCtx(),
      payload: beforeLlmPayload(),
    });

    expect(result).toEqual({
      kind: 'continue',
      payload: beforeLlmPayload({ messages: [{ role: 'system', content: 'base + memory + persona' }] }),
      warnings: [],
    });
  });

  it('provides each handler with a first-class AbortSignal', async () => {
    const bus = new HookBus();
    let seen: AbortSignal | undefined;

    bus.register('onTurnStart', async (ctx) => {
      seen = ctx.signal;
      return { kind: 'continue' };
    });

    await bus.trigger('onTurnStart', {
      ...baseCtx(),
      payload: { mode: 'chat' },
    });

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });

  it('ignores parallel option when event does not support parallel execution', async () => {
    const bus = new HookBus();
    const order: string[] = [];

    // beforeLlm is serial-only by default.
    bus.register(
      'beforeLlm',
      async () => {
        await sleep(20);
        order.push('A');
        return { kind: 'continue' };
      },
      {
        parallel: true,
        priority: 10,
      },
    );

    bus.register(
      'beforeLlm',
      async () => {
        order.push('B');
        return { kind: 'continue' };
      },
      {
        parallel: true,
        priority: 10,
      },
    );

    await bus.trigger('beforeLlm', {
      ...baseCtx(),
      payload: beforeLlmPayload(),
    });

    expect(order).toEqual(['A', 'B']);
  });

  it('runs parallel hooks concurrently when event supports parallel execution', async () => {
    const bus = new HookBus({
      maxConcurrency: 2,
      parallelEvents: new Set(['afterLlmComplete']),
    });

    const order: string[] = [];

    bus.register(
      'afterLlmComplete',
      async () => {
        await sleep(30);
        order.push('slow');
        return { kind: 'continue' };
      },
      {
        parallel: true,
        critical: false,
      },
    );

    bus.register(
      'afterLlmComplete',
      async () => {
        await sleep(5);
        order.push('fast');
        return { kind: 'continue' };
      },
      {
        parallel: true,
        critical: false,
      },
    );

    const result = await bus.trigger('afterLlmComplete', {
      ...baseCtx(),
      payload: afterLlmPayload('done'),
    });

    expect(order).toEqual(['fast', 'slow']);
    expect(result).toEqual({
      kind: 'continue',
      payload: afterLlmPayload('done'),
      warnings: [],
    });
  });

  it('隔离并冻结并行 Observer 的嵌套 Payload，不冻结业务原对象', async () => {
    const bus = new HookBus();
    const source: HookPayload['afterAssistantMessage'] = {
      messageId: 'message-1' as MessageId,
      blocks: [
        { type: 'thinking', thinking: 'private' },
        { type: 'text', text: 'answer' },
      ],
    };
    let secondHandlerTypes: string[] = [];
    let receivedIndependentSnapshot = false;
    let nestedSnapshotFrozen = false;

    bus.register('afterAssistantMessage', (ctx) => {
      receivedIndependentSnapshot = ctx.payload !== source;
      nestedSnapshotFrozen = Object.isFrozen(ctx.payload)
        && Object.isFrozen(ctx.payload.blocks)
        && Object.isFrozen(ctx.payload.blocks[0]);
      (ctx.payload.blocks as unknown as Array<{ type: string }>).push({ type: 'corrupted' });
      return { kind: 'continue' };
    }, {
      name: 'mutating-observer',
      critical: false,
      parallel: true,
    });

    bus.register('afterAssistantMessage', (ctx) => {
      secondHandlerTypes = ctx.payload.blocks.map((block) => block.type);
      return { kind: 'continue' };
    }, {
      name: 'clean-observer',
      critical: false,
      parallel: true,
    });

    const result = await bus.trigger('afterAssistantMessage', {
      ...baseCtx(),
      payload: source,
    });

    expect(receivedIndependentSnapshot).toBe(true);
    expect(nestedSnapshotFrozen).toBe(true);
    expect(secondHandlerTypes).toEqual(['thinking', 'text']);
    expect(result.payload).toBe(source);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        event: 'afterAssistantMessage',
        hook: 'mutating-observer',
      }),
    ]);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(source.blocks)).toBe(false);
    expect(source.blocks).toHaveLength(2);
  });

  it('respects maxConcurrency for parallel hooks', async () => {
    const bus = new HookBus({
      maxConcurrency: 1,
      parallelEvents: new Set(['afterLlmComplete']),
    });

    const order: string[] = [];

    bus.register(
      'afterLlmComplete',
      async () => {
        await sleep(20);
        order.push('A');
        return { kind: 'continue' };
      },
      { parallel: true, critical: false },
    );

    bus.register(
      'afterLlmComplete',
      async () => {
        order.push('B');
        return { kind: 'continue' };
      },
      { parallel: true, critical: false },
    );

    await bus.trigger('afterLlmComplete', {
      ...baseCtx(),
      payload: afterLlmPayload('done'),
    });

    // maxConcurrency = 1 means the second parallel hook waits for the first.
    expect(order).toEqual(['A', 'B']);
  });

  it('runs mixed serial and parallel batches in registration order within the same priority', async () => {
    const bus = new HookBus({
      maxConcurrency: 2,
      parallelEvents: new Set(['afterLlmComplete']),
    });

    const order: string[] = [];

    bus.register(
      'afterLlmComplete',
      async () => {
        order.push('serial-A');
        return { kind: 'continue' };
      },
      {
        priority: 10,
        parallel: false,
      },
    );

    bus.register(
      'afterLlmComplete',
      async () => {
        await sleep(20);
        order.push('parallel-B-slow');
        return { kind: 'continue' };
      },
      {
        priority: 10,
        parallel: true,
      },
    );

    bus.register(
      'afterLlmComplete',
      async () => {
        await sleep(5);
        order.push('parallel-C-fast');
        return { kind: 'continue' };
      },
      {
        priority: 10,
        parallel: true,
      },
    );

    bus.register(
      'afterLlmComplete',
      async () => {
        order.push('serial-D');
        return { kind: 'continue' };
      },
      {
        priority: 10,
        parallel: false,
      },
    );

    await bus.trigger('afterLlmComplete', {
      ...baseCtx(),
      payload: afterLlmPayload('done'),
    });

    expect(order).toEqual([
      'serial-A',
      'parallel-C-fast',
      'parallel-B-slow',
      'serial-D',
    ]);
  });

  it('observer hook returning replace records warning even when critical', async () => {
    const bus = new HookBus({
      parallelEvents: new Set(['afterLlmComplete']),
    });

    bus.register(
      'afterLlmComplete',
      async () => ({
        kind: 'replace',
        payload: afterLlmPayload('illegal'),
      }) as never,
      {
        name: 'bad-parallel-replace',
        parallel: true,
        critical: true,
      },
    );

    const emitted: EmaStreamEvent[] = [];
    const result = await bus.trigger('afterLlmComplete', {
      ...baseCtx(),
      payload: afterLlmPayload('original'),
      emit: (event) => emitted.push(event),
    });

    expect(result).toEqual({
      kind: 'continue',
      payload: afterLlmPayload('original'),
      warnings: [
        {
          event: 'afterLlmComplete',
          hook: 'bad-parallel-replace',
          reason:
            'Observer hook "bad-parallel-replace" returned replace, but observer hooks cannot alter control flow',
        },
      ],
    });
    expect(emitted).toEqual([
      expect.objectContaining({
        type: 'hook_warning',
        sessionId,
        turnId,
        hookEvent: 'afterLlmComplete',
        handlerName: 'bad-parallel-replace',
        severity: 'warn',
        failureKind: 'protocol_violation',
      }),
    ]);
  });

  it('observer hook returning replace records warning when non-critical', async () => {
    const bus = new HookBus({
      parallelEvents: new Set(['afterLlmComplete']),
    });

    bus.register(
      'afterLlmComplete',
      async () => ({
        kind: 'replace',
        payload: afterLlmPayload('illegal'),
      }) as never,
      {
        name: 'bad-parallel-replace',
        parallel: true,
        critical: false,
      },
    );

    const result = await bus.trigger('afterLlmComplete', {
      ...baseCtx(),
      payload: afterLlmPayload('original'),
    });

    expect(result).toEqual({
      kind: 'continue',
      payload: afterLlmPayload('original'),
      warnings: [
        {
          event: 'afterLlmComplete',
          hook: 'bad-parallel-replace',
          reason:
            'Observer hook "bad-parallel-replace" returned replace, but observer hooks cannot alter control flow',
        },
      ],
    });
  });

  it('observer hook returning abort records warning and continues', async () => {
    const bus = new HookBus({
      parallelEvents: new Set(['afterLlmComplete']),
    });

    const reached = vi.fn();

    bus.register(
      'afterLlmComplete',
      async () => ({ kind: 'abort', reason: 'parallel abort' }) as never,
      {
        name: 'parallel-abort',
        parallel: true,
        critical: false,
      },
    );

    bus.register(
      'afterLlmComplete',
      async () => {
        reached();
        return { kind: 'continue' };
      },
      {
        name: 'parallel-other',
        parallel: true,
        critical: false,
      },
    );

    const result = await bus.trigger('afterLlmComplete', {
      ...baseCtx(),
      payload: afterLlmPayload('done'),
    });

    expect(result).toEqual({
      kind: 'continue',
      payload: afterLlmPayload('done'),
      warnings: [
        {
          event: 'afterLlmComplete',
          hook: 'parallel-abort',
          reason:
            'Observer hook "parallel-abort" returned abort (parallel abort), but observer hooks cannot alter control flow',
        },
      ],
    });

    // Because this is a parallel batch, the other hook may already have run.
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it('parallel critical throw aborts trigger', async () => {
    const bus = new HookBus({
      parallelEvents: new Set(['beforeLlm']),
    });

    bus.register(
      'beforeLlm',
      async () => {
        throw new Error('parallel boom');
      },
      {
        name: 'critical-parallel',
        parallel: true,
        critical: true,
      },
    );

    const result = await bus.trigger('beforeLlm', {
      ...baseCtx(),
      payload: beforeLlmPayload({ messages: [{ role: 'system', content: 'done' }] }),
    });

    expect(result).toEqual({
      kind: 'abort',
      reason: 'parallel boom',
      payload: beforeLlmPayload({ messages: [{ role: 'system', content: 'done' }] }),
      warnings: [],
    });
  });

  it('parallel non-critical throw records warning and continues', async () => {
    const bus = new HookBus({
      parallelEvents: new Set(['afterLlmComplete']),
    });

    const reached = vi.fn();
    const emitted: EmaStreamEvent[] = [];

    bus.register(
      'afterLlmComplete',
      async () => {
        throw new Error('parallel telemetry failed');
      },
      {
        name: 'parallel-telemetry',
        parallel: true,
        critical: false,
      },
    );

    bus.register(
      'afterLlmComplete',
      async () => {
        reached();
        return { kind: 'continue' };
      },
      {
        name: 'parallel-observer',
        parallel: true,
        critical: false,
      },
    );

    const result = await bus.trigger('afterLlmComplete', {
      ...baseCtx(),
      payload: afterLlmPayload('done'),
      emit: (event) => emitted.push(event),
    });

    expect(reached).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      kind: 'continue',
      payload: afterLlmPayload('done'),
      warnings: [
        {
          event: 'afterLlmComplete',
          hook: 'parallel-telemetry',
          reason: 'parallel telemetry failed',
        },
      ],
    });
    expect(emitted).toEqual([
      expect.objectContaining({
        type: 'hook_warning',
        hookEvent: 'afterLlmComplete',
        handlerName: 'parallel-telemetry',
        failureKind: 'handler_error',
      }),
    ]);
  });

  it('serial hook after parallel batch sees unchanged payload', async () => {
    const bus = new HookBus({
      parallelEvents: new Set(['beforeLlm']),
    });

    let seen = '';

    bus.register(
      'beforeLlm',
      async () => ({ kind: 'continue' }),
      {
        name: 'parallel-observer',
        parallel: true,
        priority: 10,
      },
    );

    bus.register(
      'beforeLlm',
      async (ctx) => {
        seen = systemMessageContent(ctx.payload);
        return {
          kind: 'replace',
          payload: replaceSystemMessage(
            ctx.payload,
            `${systemMessageContent(ctx.payload)}-serial`,
          ),
        };
      },
      {
        name: 'serial-mutator',
        parallel: false,
        priority: 20,
      },
    );

    const result = await bus.trigger('beforeLlm', {
      ...baseCtx(),
      payload: beforeLlmPayload({ messages: [{ role: 'system', content: 'original' }] }),
    });

    expect(seen).toBe('original');
    expect(result).toEqual({
      kind: 'continue',
      payload: beforeLlmPayload({ messages: [{ role: 'system', content: 'original-serial' }] }),
      warnings: [],
    });
  });

  it('aborts a timed-out critical handler and propagates cancellation to it', async () => {
    const traces: Array<{ failureKind?: string; sessionId?: SessionId; turnId?: TurnId; timestampMs?: number }> = [];
    const emitted: EmaStreamEvent[] = [];
    const bus = new HookBus({
      handlerTimeoutMs: 10,
      traceSink: (entry) => traces.push(entry),
    });
    let handlerSawAbort = false;

    bus.register('onTurnStart', async (ctx) => {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          handlerSawAbort = true;
          resolve();
        }, { once: true });
      });
      return { kind: 'continue' };
    }, { name: 'slow-critical' });

    const result = await bus.trigger('onTurnStart', {
      ...baseCtx(),
      payload: { mode: 'chat' },
      emit: (event) => emitted.push(event),
    });

    expect(result.kind).toBe('abort');
    expect(result.kind === 'abort' ? result.reason : '').toContain('timed out after 10ms');
    expect(handlerSawAbort).toBe(true);
    expect(traces).toEqual([expect.objectContaining({
      sessionId,
      turnId,
      timestampMs: expect.any(Number),
      failureKind: 'timeout',
    })]);
    expect(emitted).toEqual([
      expect.objectContaining({
        type: 'hook_warning',
        sessionId,
        turnId,
        hookEvent: 'onTurnStart',
        handlerName: 'slow-critical',
        severity: 'error',
        failureKind: 'timeout',
        durationMs: expect.any(Number),
      }),
    ]);
  });

  it('stops the chain when the parent task is cancelled', async () => {
    const bus = new HookBus({ handlerTimeoutMs: 0 });
    const parent = new AbortController();
    const reached = vi.fn();
    const emitted: EmaStreamEvent[] = [];

    bus.register('onTurnStart', async (ctx) => {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { kind: 'continue' };
    }, { name: 'active-handler', priority: 10 });
    bus.register('onTurnStart', async () => {
      reached();
      return { kind: 'continue' };
    }, { priority: 20 });

    setTimeout(() => parent.abort(new Error('stop')), 5);
    const result = await bus.trigger('onTurnStart', {
      ...baseCtx(parent.signal),
      payload: { mode: 'chat' },
      emit: (event) => emitted.push(event),
    });

    expect(result).toEqual({
      kind: 'abort',
      reason: 'Hook execution cancelled by parent task: stop',
      payload: { mode: 'chat' },
      warnings: [],
    });
    expect(reached).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it('clears a pending timeout after a successful handler', async () => {
    vi.useFakeTimers();
    try {
      const bus = new HookBus({ handlerTimeoutMs: 30_000 });
      bus.register('onTurnStart', async () => ({ kind: 'continue' }));

      await bus.trigger('onTurnStart', {
        ...baseCtx(),
        payload: { mode: 'chat' },
      });

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('list returns registered hook metadata in priority order', () => {
    const bus = new HookBus();

    bus.register('beforeLlm', async () => ({ kind: 'continue' }), {
      name: 'inject-memory',
      priority: 20,
      critical: false,
      parallel: true,
    });

    bus.register('beforeLlm', async () => ({ kind: 'continue' }), {
      name: 'inject-card',
      priority: 10,
      critical: true,
      parallel: false,
    });

    const hooks = bus.list('beforeLlm');

    expect(hooks).toEqual([
      {
        event: 'beforeLlm',
        name: 'inject-card',
        priority: 10,
        critical: true,
        parallel: false,
      },
      {
        event: 'beforeLlm',
        name: 'inject-memory',
        priority: 20,
        critical: false,
        parallel: true,
      },
    ]);
  });

  it('throws when maxConcurrency is invalid', () => {
    expect(() => new HookBus({ maxConcurrency: 0 })).toThrow(
      'maxConcurrency must be a positive safe integer, got 0',
    );

    expect(() => new HookBus({ maxConcurrency: -1 })).toThrow(
      'maxConcurrency must be a positive safe integer, got -1',
    );
  });

  it('rejects invalid timeout configuration', () => {
    expect(() => new HookBus({ handlerTimeoutMs: -1 })).toThrow(
      'handlerTimeoutMs must be an integer between 0',
    );

    const bus = new HookBus();
    expect(() => bus.register('onTurnStart', async () => ({ kind: 'continue' }), {
      timeoutMs: Number.NaN,
    })).toThrow('HookOptions.timeoutMs must be an integer between 0');
  });
});
