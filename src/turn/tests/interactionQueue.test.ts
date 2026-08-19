// 测试统一交互队列的 per-Session FIFO、Permission/AskUser 混合排队、跨 Session 并行与队首超时。
import { describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '@ema-agent/permission';
import type { AskUserRequiredEvent } from '@ema-agent/tools';
import {
  SessionInteractionQueue,
  type PendingInteraction,
} from '../interactionQueue.js';

/** 快照定位锚：两种交互都锚定触发它的 toolCallId（含于请求本体内）。 */
const idOf = (p: PendingInteraction): string => p.request.toolCallId;

function makeQueue(timeoutMs: number | null = 60_000): SessionInteractionQueue {
  return new SessionInteractionQueue(timeoutMs);
}

function makePermissionRequest(toolCallId: string, sessionId = 's1', turnId = 't1'): PermissionRequest {
  return {
    toolName: 'Bash',
    input:   { command: 'ls' },
    sessionId,
    turnId,
    toolCallId,
  };
}

function makeAskUserRequest(toolCallId: string, sessionId = 's1', turnId = 't1'): AskUserRequiredEvent {
  return {
    type: 'ask_user_required',
    sessionId,
    turnId,
    toolCallId,
    questions: [],
  };
}

describe('SessionInteractionQueue Permission FIFO', () => {
  it('同一 Session 严格 FIFO:队首解决后下一个才升为队首', async () => {
    const q = makeQueue();
    const a = q.enqueuePermission(makePermissionRequest('c1'));
    const b = q.enqueuePermission(makePermissionRequest('c2'));

    expect(q.listPending('s1').map(idOf)).toEqual(['c1', 'c2']);

    expect(q.respondPermission('c1', { action: 'allow' })).toBe(true);
    expect((await a.promise).action).toBe('allow');
    expect(q.listPending('s1').map(idOf)).toEqual(['c2']);

    expect(q.respondPermission('c2', { action: 'deny' })).toBe(true);
    expect((await b.promise).action).toBe('deny');
    expect(q.size()).toBe(0);
  });

  it('跨 Session 并行:不同 Session 各有独立队首', async () => {
    const q = makeQueue();
    q.enqueuePermission(makePermissionRequest('c1'));
    q.enqueuePermission(makePermissionRequest('c2', 's2', 't2'));

    expect(q.listPending('s1').map(idOf)).toEqual(['c1']);
    expect(q.listPending('s2').map(idOf)).toEqual(['c2']);

    q.respondPermission('c1', { action: 'allow' });
    expect(q.listPending('s2').map(idOf)).toEqual(['c2']);
  });

  it('respondPermission 按 toolCallId 定位,未知或已解决返回 false', () => {
    const q = makeQueue();
    q.enqueuePermission(makePermissionRequest('c1'));
    expect(q.respondPermission('nonexistent', { action: 'allow' })).toBe(false);
    expect(q.respondPermission('c1', { action: 'allow' })).toBe(true);
    expect(q.respondPermission('c1', { action: 'allow' })).toBe(false);
  });

  it('Permission 响应必须属于 URL 指定的 Turn', () => {
    const q = makeQueue();
    q.enqueuePermission(makePermissionRequest('call-a', 'session-a', 'turn-a'));

    expect(q.respondPermission('call-a', { action: 'allow' }, 'turn-stale')).toBe(false);
    expect(q.respondPermission('call-a', { action: 'allow' }, 'turn-a')).toBe(true);
  });

  it('respondAskUser 不能解决 Permission 条目(类型互斥)', () => {
    const q = makeQueue();
    q.enqueuePermission(makePermissionRequest('c1'));
    expect(q.respondAskUser('c1', {})).toBe(false);
    expect(q.size()).toBe(1);
  });

  it('Permission 非队首不能越过当前活动交互', () => {
    const q = makeQueue();
    q.enqueuePermission(makePermissionRequest('c1'));
    q.enqueuePermission(makePermissionRequest('c2'));

    expect(q.respondPermission('c2', { action: 'allow' })).toBe(false);
    expect(q.listPending('s1').map(idOf)).toEqual(['c1', 'c2']);
  });
});

describe('SessionInteractionQueue AskUser FIFO', () => {
  it('同一 Session AskUser 串行排队', async () => {
    const q = makeQueue();
    const a = q.enqueueAskUser(makeAskUserRequest('p1'));
    const b = q.enqueueAskUser(makeAskUserRequest('p2'));

    expect(q.listPending('s1').map(idOf)).toEqual(['p1', 'p2']);

    expect(q.respondAskUser('p1', { q0: 'yes' })).toBe(true);
    expect(await a.promise).toEqual({ status: 'answered', answers: { q0: 'yes' } });

    expect(q.respondAskUser('p2', { q0: 'no' })).toBe(true);
    expect(await b.promise).toEqual({ status: 'answered', answers: { q0: 'no' } });
    expect(q.size()).toBe(0);
  });

  it('respondAskUser 按 toolCallId 定位', () => {
    const q = makeQueue();
    q.enqueueAskUser(makeAskUserRequest('p1'));
    expect(q.respondAskUser('nonexistent', {})).toBe(false);
    expect(q.respondAskUser('p1', { q0: 'yes' })).toBe(true);
    expect(q.respondAskUser('p1', { q0: 'yes' })).toBe(false);
  });

  it('拒绝重复交互 id，避免覆盖索引后遗留永不结束的等待项', () => {
    const q = makeQueue();
    q.enqueueAskUser(makeAskUserRequest('duplicate'));

    expect(() => q.enqueueAskUser(makeAskUserRequest('duplicate', 's2', 't2')))
      .toThrow('Duplicate interaction id: duplicate');
    expect(q.size()).toBe(1);
  });

  it('拒绝响应非队首条目和 Turn 身份不匹配的陈旧卡片', () => {
    const q = makeQueue();
    q.enqueueAskUser(makeAskUserRequest('p1'));
    q.enqueueAskUser(makeAskUserRequest('p2', 's1', 't2'));

    expect(q.respondAskUser('p2', { q0: 'early' }, 't2')).toBe(false);
    expect(q.respondAskUser('p1', { q0: 'wrong turn' }, 't2')).toBe(false);
    expect(q.listPending('s1').map(idOf)).toEqual(['p1', 'p2']);
  });
});

describe('SessionInteractionQueue Permission 与 AskUser 混合 FIFO', () => {
  it('同 Session [permission, askUser, permission] 按进入顺序共同排队', async () => {
    const q = makeQueue();
    const perm1 = q.enqueuePermission(makePermissionRequest('c1'));
    const ask1  = q.enqueueAskUser(makeAskUserRequest('a1'));
    const perm2 = q.enqueuePermission(makePermissionRequest('c2'));

    // 队首是 perm1,其余排队
    expect(q.listPending('s1').map(idOf)).toEqual(['c1', 'a1', 'c2']);

    // 解决队首 perm1,ask1 升为队首
    q.respondPermission('c1', { action: 'allow' });
    expect((await perm1.promise).action).toBe('allow');
    expect(q.listPending('s1').map(idOf)).toEqual(['a1', 'c2']);

    // 解决 ask1,perm2 升为队首
    q.respondAskUser('a1', { q0: 'yes' });
    expect(await ask1.promise).toEqual({ status: 'answered', answers: { q0: 'yes' } });
    expect(q.listPending('s1').map(idOf)).toEqual(['c2']);

    // 解决 perm2
    q.respondPermission('c2', { action: 'deny' });
    expect((await perm2.promise).action).toBe('deny');
    expect(q.size()).toBe(0);
  });

  it('跨 Session Permission 与 AskUser 并行互不阻塞', () => {
    const q = makeQueue();
    q.enqueuePermission(makePermissionRequest('c1'));
    q.enqueueAskUser(makeAskUserRequest('a1', 's2', 't2'));

    // 两个 Session 各有独立队首,互不阻塞
    expect(q.listPending('s1').map(idOf)).toHaveLength(1);
    expect(q.listPending('s2').map(idOf)).toEqual(['a1']);
  });

  it('cancelForTurn 混合取消:一次取消该 Turn 全部 Permission 与 AskUser', async () => {
    const q = makeQueue();
    const perm1 = q.enqueuePermission(makePermissionRequest('c1'));
    const ask1  = q.enqueueAskUser(makeAskUserRequest('a1'));
    // 不同 Turn 的条目应保留
    q.enqueuePermission(makePermissionRequest('c2', 's1', 't2'));

    const n = q.cancelForTurn('t1', 'turn aborted');
    expect(n).toBe(2);
    // Permission 以 deny resolve
    expect((await perm1.promise).action).toBe('deny');
    expect(await ask1.promise).toEqual({
      status: 'cancelled',
      reason: 'turn aborted',
    });
    // t2 的 perm2 保留并升为队首
    expect(q.listPending('s1').map(idOf)).toEqual(['c2']);
  });

  it('cancelForSession 混合取消:取消该 Session 全部待交互', async () => {
    const q = makeQueue();
    const perm1 = q.enqueuePermission(makePermissionRequest('c1'));
    const ask1  = q.enqueueAskUser(makeAskUserRequest('a1'));
    // 不同 Session 的条目应保留
    q.enqueuePermission(makePermissionRequest('c2', 's2', 't2'));

    const n = q.cancelForSession('s1', 'session deleted');
    expect(n).toBe(2);
    expect((await perm1.promise).action).toBe('deny');
    expect(await ask1.promise).toEqual({
      status: 'cancelled',
      reason: 'session deleted',
    });
    expect(q.listPending('s2').map(idOf)).toEqual(['c2']);
  });

  it('listPending(sessionId) 混合快照队首在前;不传返回全部按 createdAt 升序', () => {
    const q = makeQueue();
    q.enqueuePermission(makePermissionRequest('c1'));
    q.enqueueAskUser(makeAskUserRequest('b1'));
    q.enqueuePermission(makePermissionRequest('c2', 's2', 't2'));

    // s1 混合快照:队首 c1 在前,b1 在后
    const s1 = q.listPending('s1');
    expect(s1.map(p => ({ kind: p.kind, id: idOf(p) }))).toEqual([
      { kind: 'permission', id: 'c1' },
      { kind: 'askUser',    id: 'b1' },
    ]);

    // 全部按 createdAt 升序
    const all = q.listPending();
    expect(all.map(idOf)).toEqual(['c1', 'b1', 'c2']);
  });

  it('队首超时不并发计时:混合场景下队首超时后下一个才计时', async () => {
    vi.useFakeTimers();
    try {
      const q = makeQueue(1_000);
      const perm = q.enqueuePermission(makePermissionRequest('c1'));
      const ask  = q.enqueueAskUser(makeAskUserRequest('a1'));

      // 推进 1000ms:只有队首 perm 应超时
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await perm.promise).action).toBe('deny');
      // ask 还未超时(刚才在排队,现在升为队首开始计时)
      expect(q.listPending('s1').map(idOf)).toEqual(['a1']);

      // 再推进 1000ms:ask 超时
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await ask.promise).toEqual({
        status: 'timed_out',
        reason: 'timed out after 1000ms',
      });
      expect(q.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('超时为 null 时一直等待，直到用户响应或生命周期取消', async () => {
    vi.useFakeTimers();
    try {
      const q = makeQueue(null);
      const pending = q.enqueuePermission(makePermissionRequest('c1'));

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
      expect(q.listPending('s1')).toHaveLength(1);
      expect(q.respondPermission('c1', { action: 'allow' })).toBe(true);
      await expect(pending.promise).resolves.toEqual({ action: 'allow' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel 单条按 kind resolve:permission→deny,askUser→明确取消终态', async () => {
    const q = makeQueue();
    const perm = q.enqueuePermission(makePermissionRequest('c1'));
    const ask  = q.enqueueAskUser(makeAskUserRequest('a1', 's2', 't2'));

    expect(q.cancel('c1', 'test')).toBe(true);
    expect((await perm.promise).action).toBe('deny');
    expect((await perm.promise).reason).toBe('test');

    expect(q.cancel('a1', 'test')).toBe(true);
    expect(await ask.promise).toEqual({
      status: 'cancelled',
      reason: 'test',
    });
    expect(q.size()).toBe(0);
  });

  it('用户取消只接受匹配 Turn 的活动队首', () => {
    const q = makeQueue();
    q.enqueueAskUser(makeAskUserRequest('a1'));
    q.enqueueAskUser(makeAskUserRequest('a2', 's1', 't2'));

    expect(q.cancelAskUser('a2', 'cancelled', 't2')).toBe(false);
    expect(q.cancelAskUser('a1', 'cancelled', 'wrong-turn')).toBe(false);
    expect(q.listPending('s1').map(idOf)).toEqual(['a1', 'a2']);
  });

  it('路由取消入口不能跨 Permission 与 AskUser 类型操作', () => {
    const q = makeQueue();
    q.enqueuePermission(makePermissionRequest('tc1'));

    expect(q.cancelAskUser('tc1', 'wrong kind', 't1')).toBe(false);
    expect(q.cancelPermission('tc1', 'cancelled', 't1')).toBe(true);

    q.enqueueAskUser(makeAskUserRequest('a1'));

    expect(q.cancelPermission('a1', 'wrong kind', 't1')).toBe(false);
    expect(q.cancelAskUser('a1', 'cancelled', 't1')).toBe(true);
  });
});
