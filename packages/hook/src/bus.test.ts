import { describe, it, expect, vi } from 'vitest';
import { HookBus } from './bus.js';
import { PRIORITY } from './priority.js';
import type { TurnId, SessionId } from '@ema-agent/contracts';

const turnId = 'turn-1' as TurnId;
const sessionId = 'session-1' as SessionId;

function baseCtx(meta: Record<string, unknown> = {}) {
  return { scope: 'turn' as const, turnId, sessionId, meta };
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
      payload: { content: 'hello' },
    });

    expect(reached).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      kind: 'continue',
      payload: { content: 'hello' },
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

    bus.register(
      'beforeLlm',
      async () => ({
        kind: 'replace',
        payload: {
          systemPrompt: 'new-system',
          messages: [],
        },
      }),
      { priority: PRIORITY.FIRST },
    );

    bus.register('beforeLlm', async (ctx) => {
      seen = ctx.payload.systemPrompt;
      return { kind: 'continue' };
    });

    const result = await bus.trigger('beforeLlm', {
      ...baseCtx(),
      payload: {
        systemPrompt: 'old-system',
        messages: [],
      },
    });

    expect(seen).toBe('new-system');
    expect(result).toEqual({
      kind: 'continue',
      payload: {
        systemPrompt: 'new-system',
        messages: [],
      },
      warnings: [],
    });
  });

  it('serial multiple replace returns final payload', async () => {
    const bus = new HookBus();

    bus.register(
      'beforeLlm',
      async (ctx) => ({
        kind: 'replace',
        payload: {
          ...ctx.payload,
          systemPrompt: `${ctx.payload.systemPrompt} + memory`,
        },
      }),
      { priority: 10 },
    );

    bus.register(
      'beforeLlm',
      async (ctx) => ({
        kind: 'replace',
        payload: {
          ...ctx.payload,
          systemPrompt: `${ctx.payload.systemPrompt} + persona`,
        },
      }),
      { priority: 20 },
    );

    const result = await bus.trigger('beforeLlm', {
      ...baseCtx(),
      payload: {
        systemPrompt: 'base',
        messages: [],
      },
    });

    expect(result).toEqual({
      kind: 'continue',
      payload: {
        systemPrompt: 'base + memory + persona',
        messages: [],
      },
      warnings: [],
    });
  });

  it('keeps meta shared across handlers in the same trigger call', async () => {
    const bus = new HookBus();
    const meta: Record<string, unknown> = {};
    let seen: unknown;

    bus.register(
      'onTurnStart',
      async (ctx) => {
        ctx.meta.started = true;
        return { kind: 'continue' };
      },
      { priority: 10 },
    );

    bus.register(
      'onTurnStart',
      async (ctx) => {
        seen = ctx.meta.started;
        return { kind: 'continue' };
      },
      { priority: 20 },
    );

    await bus.trigger('onTurnStart', {
      ...baseCtx(meta),
      payload: { mode: 'chat' },
    });

    expect(seen).toBe(true);
    expect(meta.started).toBe(true);
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
      payload: {
        systemPrompt: 'base',
        messages: [],
      },
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
      payload: { content: 'done' },
    });

    expect(order).toEqual(['fast', 'slow']);
    expect(result).toEqual({
      kind: 'continue',
      payload: { content: 'done' },
      warnings: [],
    });
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
      payload: { content: 'done' },
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
      payload: { content: 'done' },
    });

    expect(order).toEqual([
      'serial-A',
      'parallel-C-fast',
      'parallel-B-slow',
      'serial-D',
    ]);
  });

  it('parallel hook returning replace aborts when critical', async () => {
    const bus = new HookBus({
      parallelEvents: new Set(['afterLlmComplete']),
    });

    bus.register(
      'afterLlmComplete',
      async () => ({
        kind: 'replace',
        payload: { content: 'illegal' },
      }),
      {
        name: 'bad-parallel-replace',
        parallel: true,
        critical: true,
      },
    );

    const result = await bus.trigger('afterLlmComplete', {
      ...baseCtx(),
      payload: { content: 'original' },
    });

    expect(result).toEqual({
      kind: 'abort',
      reason:
        'Parallel hook "bad-parallel-replace" returned replace, but parallel hooks cannot replace payload',
      payload: { content: 'original' },
      warnings: [],
    });
  });

  it('parallel hook returning replace records warning when non-critical', async () => {
    const bus = new HookBus({
      parallelEvents: new Set(['afterLlmComplete']),
    });

    bus.register(
      'afterLlmComplete',
      async () => ({
        kind: 'replace',
        payload: { content: 'illegal' },
      }),
      {
        name: 'bad-parallel-replace',
        parallel: true,
        critical: false,
      },
    );

    const result = await bus.trigger('afterLlmComplete', {
      ...baseCtx(),
      payload: { content: 'original' },
    });

    expect(result).toEqual({
      kind: 'continue',
      payload: { content: 'original' },
      warnings: [
        {
          event: 'afterLlmComplete',
          hook: 'bad-parallel-replace',
          reason:
            'Parallel hook "bad-parallel-replace" returned replace, but parallel hooks cannot replace payload',
        },
      ],
    });
  });

  it('parallel hook returning abort aborts trigger even when non-critical', async () => {
    const bus = new HookBus({
      parallelEvents: new Set(['afterLlmComplete']),
    });

    const reached = vi.fn();

    bus.register(
      'afterLlmComplete',
      async () => ({ kind: 'abort', reason: 'parallel abort' }),
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
      payload: { content: 'done' },
    });

    expect(result).toEqual({
      kind: 'abort',
      reason: 'parallel abort',
      payload: { content: 'done' },
      warnings: [],
    });

    // Because this is a parallel batch, the other hook may already have run.
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it('parallel critical throw aborts trigger', async () => {
    const bus = new HookBus({
      parallelEvents: new Set(['afterLlmComplete']),
    });

    bus.register(
      'afterLlmComplete',
      async () => {
        throw new Error('parallel boom');
      },
      {
        name: 'critical-parallel',
        parallel: true,
        critical: true,
      },
    );

    const result = await bus.trigger('afterLlmComplete', {
      ...baseCtx(),
      payload: { content: 'done' },
    });

    expect(result).toEqual({
      kind: 'abort',
      reason: 'parallel boom',
      payload: { content: 'done' },
      warnings: [],
    });
  });

  it('parallel non-critical throw records warning and continues', async () => {
    const bus = new HookBus({
      parallelEvents: new Set(['afterLlmComplete']),
    });

    const reached = vi.fn();

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
      payload: { content: 'done' },
    });

    expect(reached).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      kind: 'continue',
      payload: { content: 'done' },
      warnings: [
        {
          event: 'afterLlmComplete',
          hook: 'parallel-telemetry',
          reason: 'parallel telemetry failed',
        },
      ],
    });
  });

  it('serial hook after parallel batch sees unchanged payload', async () => {
    const bus = new HookBus({
      parallelEvents: new Set(['afterLlmComplete']),
    });

    let seen = '';

    bus.register(
      'afterLlmComplete',
      async () => ({ kind: 'continue' }),
      {
        name: 'parallel-observer',
        parallel: true,
        priority: 10,
      },
    );

    bus.register(
      'afterLlmComplete',
      async (ctx) => {
        seen = ctx.payload.content;
        return {
          kind: 'replace',
          payload: { content: `${ctx.payload.content}-serial` },
        };
      },
      {
        name: 'serial-mutator',
        parallel: false,
        priority: 20,
      },
    );

    const result = await bus.trigger('afterLlmComplete', {
      ...baseCtx(),
      payload: { content: 'original' },
    });

    expect(seen).toBe('original');
    expect(result).toEqual({
      kind: 'continue',
      payload: { content: 'original-serial' },
      warnings: [],
    });
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
      'maxConcurrency must be greater than 0, got 0',
    );

    expect(() => new HookBus({ maxConcurrency: -1 })).toThrow(
      'maxConcurrency must be greater than 0, got -1',
    );
  });

  it('runs app-scoped hooks without turn/session context', async () => {
    const bus = new HookBus();
    const seen = vi.fn();

    bus.register('onCharacterCardSwitch', async (ctx) =>  {
      seen(ctx.payload.previousCardId, ctx.payload.nextCardId);
      return { kind: 'continue' };
    });

    const result = await bus.trigger('onCharacterCardSwitch', {
      scope: 'app',
      meta: {},
      payload: { previousCardId: 'card-1' as any, nextCardId: 'card-2' as any },
    });

    expect(seen).toHaveBeenCalledWith('card-1', 'card-2');

    expect(result).toEqual({
      kind: 'continue',
      payload: { previousCardId: 'card-1', nextCardId: 'card-2' },
      warnings: [],
    });
  });
});