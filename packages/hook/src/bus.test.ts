import { describe, it, expect, vi } from 'vitest';
import { HookBus } from '../src/bus.js';
import { PRIORITY } from '../src/priority.js';
import type { TurnId, SessionId } from '@ema-agent/contracts';

const turnId = 'turn-1' as TurnId;
const sessionId = 'session-1' as SessionId;
const noop = () => {};

function baseCtx() {
  return {
    turnId,
    sessionId,
    emit: noop as never,
    abort: noop,
    meta: {},
  };
}

describe('HookBus', () => {
  it('runs handlers in priority order', async () => {
    const bus = new HookBus();
    const order: number[] = [];

    bus.register('onTurnStart', async () => { order.push(2); return { kind: 'continue' }; }, { priority: PRIORITY.EARLY });
    bus.register('onTurnStart', async () => { order.push(1); return { kind: 'continue' }; }, { priority: PRIORITY.FIRST });
    bus.register('onTurnStart', async () => { order.push(3); return { kind: 'continue' }; }, { priority: PRIORITY.DEFAULT });

    await bus.trigger('onTurnStart', { ...baseCtx(), payload: { mode: 'chat' } });
    expect(order).toEqual([1, 2, 3]);
  });

  it('stops chain on abort', async () => {
    const bus = new HookBus();
    const reached = vi.fn();

    bus.register('onTurnStart', async () => ({ kind: 'abort', reason: 'test' }), { priority: PRIORITY.FIRST });
    bus.register('onTurnStart', async () => { reached(); return { kind: 'continue' }; });

    const result = await bus.trigger('onTurnStart', { ...baseCtx(), payload: { mode: 'chat' } });
    expect(result).toEqual({ kind: 'abort', reason: 'test' });
    expect(reached).not.toHaveBeenCalled();
  });

  it('catches thrown errors as abort', async () => {
    const bus = new HookBus();
    bus.register('onTurnStart', async () => { throw new Error('boom'); });

    const result = await bus.trigger('onTurnStart', { ...baseCtx(), payload: { mode: 'chat' } });
    expect(result).toEqual({ kind: 'abort', reason: 'boom' });
  });

  it('unregisters handler', async () => {
    const bus = new HookBus();
    const handler = vi.fn(async () => ({ kind: 'continue' as const }));
    const unregister = bus.register('onTurnEnd', handler);
    unregister();
    await bus.trigger('onTurnEnd', { ...baseCtx(), payload: { durationMs: 100 } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns continue when no handlers', async () => {
    const bus = new HookBus();
    const result = await bus.trigger('onTurnAbort', { ...baseCtx(), payload: { reason: 'user_stop' } });
    expect(result).toEqual({ kind: 'continue' });
  });

  it('lists all registered hooks', () => {
    const bus = new HookBus();
    bus.register('beforeLlm', async () => ({ kind: 'continue' }), { name: 'inject-card', priority: 10 });
    bus.register('beforeLlm', async () => ({ kind: 'continue' }), { name: 'inject-memory', priority: 20 });
    const hooks = bus.list('beforeLlm');
    expect(hooks.map(h => h.name)).toEqual(['inject-card', 'inject-memory']);
  });
});
