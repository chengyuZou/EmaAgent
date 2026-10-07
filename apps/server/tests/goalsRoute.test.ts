import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { GoalStore } from '@ema-agent/goal';
import { SessionRunningRegistry, SessionStore } from '@ema-agent/session';
import { Database } from '@ema-agent/storage';
import { SessionContinuationQueue } from '@ema-agent/turn';
import { goalsRoute } from '../src/routes/goals.js';

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('Goal HTTP 编辑交付', () => {
  it.each(['idle', 'turn', 'compact'] as const)('%s 的 PUT 保存最新目标, 只有运行中根 Turn 领取隐藏消息', async mode => {
    const db = new Database({ memory: true, kind: 'data' });
    db.migrate();
    databases.push(db);
    const sessions = new SessionStore({ db });
    const session = sessions.createSession({ cwd: os.tmpdir() });
    const running = new SessionRunningRegistry();
    const startTurn = vi.fn();
    const publish = vi.fn();
    let queue: SessionContinuationQueue;
    const goals = new GoalStore(db, event => {
      if (event.type === 'goal_edited') queue.goalEdited(event.goal);
    });
    queue = new SessionContinuationQueue({
      sessions,
      sessionRunning: running,
      goals,
      startTurn,
      attachTurn: () => undefined,
      publish,
    });
    const original = goals.create(session.id, '原目标');
    if (mode === 'turn') running.register(session.id, { kind: 'turn', turnId: 'root' });
    else if (mode === 'compact') running.register(session.id, { kind: 'compact', compactId: 'compact' });
    const app = new Hono().route('/api/goals', goalsRoute(goals));
    try {
      const response = await app.request(`/api/goals/${original.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, expectedVersion: original.version, objective: 'HTTP 更新后的目标' }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ goal: {
        id: original.id, objective: 'HTTP 更新后的目标', version: 2, status: 'active',
      } });
      const claim = queue.claimNextIteration(session.id, 'root');
      if (mode === 'turn') {
        expect(claim).toMatchObject({ type: 'continuation', continuationText: expect.stringContaining('HTTP 更新后的目标') });
        queue.acknowledge('root');
      } else {
        expect(claim).toBeUndefined();
      }
      await Promise.resolve();
      expect(startTurn).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      const conflict = await app.request(`/api/goals/${original.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, expectedVersion: original.version, objective: '旧版本覆盖' }),
      });
      expect(conflict.status).toBe(409);
      expect(goals.getCurrent(session.id)?.objective).toBe('HTTP 更新后的目标');
      expect(queue.claimNextIteration(session.id, 'root')).toBeUndefined();
    } finally {
      queue.shutdown();
    }
  });
});
