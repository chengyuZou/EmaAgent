// 验证真实 SQL 上的 Goal 三态、身份版本竞争、提交后事件和重启暂停.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, GoalsRepo, SessionsRepo } from '@ema-agent/storage';
import { GoalStore } from '../goalStore.js';
import { GoalError } from '../error.js';
import type { Goal, GoalIdentity } from '../types.js';
import type { GoalEvent } from '../events.js';

const databases: Database[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeStore() {
  const db = new Database({ memory: true, kind: 'data' });
  databases.push(db);
  db.migrate();
  const sessions = new SessionsRepo(db.sqlite);
  const events: GoalEvent[] = [];
  const store = new GoalStore(db, event => {
    expect(db.sqlite.inTransaction).toBe(false);
    if (event.type !== 'goal_deleted') {
      expect(store.get(event.goal.sessionId, event.goal.id)).toEqual(event.goal);
    }
    events.push(event);
  });
  sessions.insert({ id: 'session', title: 'Session', cwd: '/workspace', createdAt: 1, updatedAt: 1 });
  return { db, sessions, store, events };
}

function identity(goal: Goal): GoalIdentity {
  return { sessionId: goal.sessionId, goalId: goal.id, expectedVersion: goal.version };
}

describe('GoalStore', () => {
  it('完成时一次写入终态和新的累计反馈, 不留下上一轮进度', () => {
    const { db, store, events } = makeStore();
    const earlier = store.reportFeedback(identity(store.create('session', '整理 8 个 README')), '累计已整理 6/8');
    const completed = store.complete(identity(earlier), '8/8 已整理并汇总, 完整结果见最终回复');
    expect(completed).toMatchObject({
      status: 'completed', reason: 'succeeded', version: earlier.version + 1,
      feedback: '8/8 已整理并汇总, 完整结果见最终回复',
    });
    expect(new GoalsRepo(db.sqlite).findById('session', completed.id)?.feedback).toBe(completed.feedback);
    expect(events.at(-1)).toEqual({ type: 'goal_completed', goal: completed });
  });

  it('历史列表只映射 Summary 字段, 详情仍保留反馈和失败说明', () => {
    const { db, sessions, store } = makeStore();
    const reported = store.reportFeedback(identity(store.create('session', '目标一')), '前半部分已完成');
    const failed = store.fail(identity(reported), '前半部分完成, 剩余部分无法继续', '缺少必要输入');
    const active = store.create('session', '目标二');
    db.sqlite.prepare('UPDATE goals SET created_at = ? WHERE id = ?').run(1, failed.id);
    db.sqlite.prepare('UPDATE goals SET created_at = ? WHERE id = ?').run(2, active.id);
    sessions.insert({ id: 'other', title: 'Other', cwd: '/workspace', createdAt: 1, updatedAt: 1 });
    store.create('other', '别的 Session');

    expect(store.listSummaries('session')).toEqual([
      {
        id: active.id, sessionId: 'session', objective: '目标二', status: 'active', reason: null,
        createdAt: 2, updatedAt: active.updatedAt, completedAt: null,
      },
      {
        id: failed.id, sessionId: 'session', objective: '目标一', status: 'completed', reason: 'failed',
        createdAt: 1, updatedAt: failed.updatedAt, completedAt: failed.completedAt,
      },
    ]);
    expect(store.get('session', failed.id)).toEqual({ ...failed, createdAt: 1 });
    expect(store.listSummaries('missing')).toEqual([]);
    expect(Object.keys(new GoalsRepo(db.sqlite).listSummariesForSession('session')[0]!))
      .toEqual(['id', 'session_id', 'objective', 'status', 'reason', 'created_at', 'updated_at', 'completed_at']);
  });

  it('反馈只保留最新进度, 同内容不重复写入, 用户修改目标后清空旧反馈', () => {
    const { db, store, events } = makeStore();
    const created = store.create('session', '整理 8 个 README');
    expect(created.feedback).toBeNull();
    const first = store.reportFeedback(identity(created), ' 已整理 2/8 ');
    expect(first).toMatchObject({ feedback: '已整理 2/8', status: 'active', version: 2 });
    expect(new GoalsRepo(db.sqlite).findById('session', first.id)?.feedback).toBe('已整理 2/8');
    expect(store.reportFeedback(identity(first), '已整理 2/8')).toEqual(first);
    const latest = store.reportFeedback(identity(first), '已整理 4/8');
    expect(store.getCurrent('session')).toEqual(latest);
    expect(store.get('session', created.id)?.feedback).toBe('已整理 4/8');
    expect(store.edit(identity(latest), latest.objective)).toEqual(latest);
    const edited = store.edit(identity(latest), '只整理两个文件');
    expect(edited).toMatchObject({ feedback: null, version: 4 });
    expect(events.map(event => event.type)).toEqual([
      'goal_created', 'goal_updated', 'goal_updated', 'goal_updated',
    ]);
  });

  it('旧版本, paused, completed 和已删除目标不能报告进度或被反馈重新激活', () => {
    const { store } = makeStore();
    const created = store.create('session', '目标');
    expect(() => store.reportFeedback(identity(created), ' ')).toThrow('goal_feedback_empty');
    const reported = store.reportFeedback(identity(created), '完成前半部分');
    expect(() => store.reportFeedback(identity(created), '旧报告')).toThrow('goal_version_conflict');
    const paused = store.pause(identity(reported));
    expect(() => store.reportFeedback(identity(paused), '继续')).toThrow('goal_status_conflict');
    const active = store.activate(identity(paused));
    const completed = store.complete(identity(active), '已完成全部工作');
    expect(completed.feedback).toBe('已完成全部工作');
    expect(() => store.reportFeedback(identity(completed), '恢复')).toThrow('goal_status_conflict');
    store.delete(identity(completed));
    expect(() => store.reportFeedback(identity(completed), '重建')).toThrow('goal_not_found');
    expect(store.getCurrent('session')).toBeNull();
  });

  it('新建立即 active, SQL 只允许一条 active/paused, 取消保留历史后才允许新建', () => {
    const { db, store, events } = makeStore();
    const a = store.create('session', '  原始目标  ');
    expect(a).toMatchObject({ objective: '  原始目标  ', status: 'active', version: 1, reason: null });
    expect(store.getCurrent('session')).toEqual(a);
    expect(() => store.create('session', '另一个目标')).toThrow('goal_already_exists');
    const row = new GoalsRepo(db.sqlite).findById('session', a.id)!;
    expect(row.objective).toBe('  原始目标  ');
    expect(() => new GoalsRepo(db.sqlite).insert({ ...row, id: 'duplicate', status: 'paused' }))
      .toThrow(/UNIQUE constraint/);

    const paused = store.pause(identity(a));
    expect(() => store.create('session', '另一个目标')).toThrow('goal_already_exists');
    const cancelled = store.cancel(identity(paused));
    const b = store.create('session', '新的目标');
    expect(b.id).not.toBe(a.id);
    expect(store.getCurrent('session')).toEqual(b);
    expect(store.listSummaries('session').map(goal => goal.id))
      .toEqual(expect.arrayContaining([cancelled.id, b.id]));
    expect(events.map(event => event.type)).toEqual([
      'goal_created', 'goal_paused', 'goal_cancelled', 'goal_created',
    ]);
  });

  it('修改、暂停、激活各递增版本, 无实际修改不递增版本或发重复事件', () => {
    const { store, events } = makeStore();
    const a = store.create('session', '目标');
    expect(store.edit(identity(a), '目标')).toEqual(a);
    expect(store.activate(identity(a))).toEqual(a);
    const edited = store.edit(identity(a), '新要求');
    const paused = store.pause(identity(edited));
    expect(store.pause(identity(paused))).toEqual(paused);
    expect(() => store.complete(identity(paused), '完成概况')).toThrow('goal_status_conflict');
    expect(() => store.fail(identity(paused), '当前进度', '错误')).toThrow('goal_status_conflict');
    const active = store.activate(identity(paused));
    expect(active).toMatchObject({ id: a.id, status: 'active', version: 4, objective: '新要求' });
    expect(events.map(event => event.type)).toEqual([
      'goal_created', 'goal_updated', 'goal_paused', 'goal_activated',
    ]);
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)('终态 %s 都是 completed, 只有失败保存 error', reason => {
    const { store, events } = makeStore();
    const a = store.create('session', '目标');
    let completed: Goal;
    let eventType: GoalEvent['type'];
    if (reason === 'succeeded') {
      completed = store.complete(identity(a), '目标完成');
      eventType = 'goal_completed';
    } else if (reason === 'failed') {
      completed = store.fail(identity(a), '目标无法完成', ' 最终失败说明 ');
      eventType = 'goal_failed';
    } else {
      completed = store.cancel(identity(a));
      eventType = 'goal_cancelled';
    }
    expect(completed).toMatchObject({
      id: a.id, status: 'completed', reason, version: 2,
      error: reason === 'failed' ? '最终失败说明' : null,
    });
    expect(completed.completedAt).not.toBeNull();
    expect(store.getCurrent('session')).toBeNull();
    expect(events.at(-1)).toEqual({ type: eventType, goal: completed });
    expect(() => store.activate(identity(completed))).toThrow('goal_status_conflict');
    expect(() => store.edit(identity(completed), '恢复')).toThrow('goal_status_conflict');
    expect(store.get('session', a.id)).toEqual(completed);
  });

  it('旧版本完成和删除都报冲突, 返回最新事实且不发成功事件', () => {
    const { store, events } = makeStore();
    const a = store.create('session', '目标 v1');
    const latest = store.edit(identity(a), '目标 v2');
    for (const attempt of [() => store.complete(identity(a), '完成概况'), () => store.delete(identity(a))]) {
      try {
        attempt();
        expect.fail('旧版本不能成功');
      } catch (error) {
        expect(error).toBeInstanceOf(GoalError);
        expect(error).toMatchObject({ code: 'goal_version_conflict', current: latest });
      }
    }
    expect(events).toHaveLength(2);
    expect(store.getCurrent('session')).toEqual(latest);
  });

  it('A 取消后新建 B, 旧 A 不能修改 B; 删除 A 后迟到写入也不能新建或恢复', () => {
    const { store, events } = makeStore();
    const a = store.create('session', 'A');
    const closed = store.cancel(identity(a));
    const b = store.create('session', 'B');
    expect(() => store.complete(identity(a), '完成概况')).toThrow('goal_version_conflict');
    expect(() => store.complete(identity(closed), '完成概况')).toThrow('goal_status_conflict');
    store.delete(identity(closed));
    expect(events.at(-1)).toEqual({ type: 'goal_deleted', sessionId: 'session', goalId: a.id });
    expect(() => store.pause(identity(a))).toThrow('goal_not_found');
    expect(store.getCurrent('session')).toEqual(b);
    expect(store.listSummaries('session').map(goal => goal.id)).toEqual([b.id]);
    expect(events).toHaveLength(4);
  });

  it('跨 Session 的身份不能修改或删除其它 Session 目标', () => {
    const { sessions, store, events } = makeStore();
    sessions.insert({ id: 'other', title: 'Other', cwd: '/workspace', createdAt: 1, updatedAt: 1 });
    const a = store.create('session', 'A');
    const wrong = { ...identity(a), sessionId: 'other' };
    expect(() => store.complete(wrong, '完成概况')).toThrow('goal_not_found');
    expect(() => store.delete(wrong)).toThrow('goal_not_found');
    expect(store.getCurrent('session')).toEqual(a);
    expect(events).toHaveLength(1);
  });

  it('Plan 下拒绝创建, 空正文与空失败原因不落库, 未知 Session 不创建孤儿目标', () => {
    const { sessions, store, events } = makeStore();
    sessions.patch('session', { permissionMode: 'plan' }, Date.now());
    expect(() => store.create('session', '目标')).toThrow('goal_plan_conflict');
    expect(() => store.create('missing', '目标')).toThrow('session_not_found');
    expect(() => store.create('session', ' ')).toThrow('goal_objective_empty');
    expect(events).toEqual([]);
    sessions.patch('session', { permissionMode: 'default' }, Date.now());
    const a = store.create('session', '目标');
    expect(() => store.fail(identity(a), '当前进度', ' ')).toThrow('goal_error_empty');
    expect(store.getCurrent('session')).toEqual(a);
    expect(events).toHaveLength(1);
  });

  it('真实文件数据库重开后 active 转 paused, 保留 ID 并递增版本, 不变更其它状态', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ema-goal-test-'));
    directories.push(directory);
    const path = join(directory, 'data.db');
    const before = new Database({ path, kind: 'data' });
    databases.push(before);
    before.migrate();
    const sessions = new SessionsRepo(before.sqlite);
    for (const id of ['active', 'paused', 'completed']) {
      sessions.insert({ id, title: id, cwd: '/workspace', createdAt: 1, updatedAt: 1 });
    }
    const originalStore = new GoalStore(before);
    const active = originalStore.create('active', '执行中');
    const paused = originalStore.pause(identity(originalStore.create('paused', '已暂停')));
    const completed = originalStore.complete(identity(originalStore.create('completed', '已完成')), '已完成');
    before.close();

    const after = new Database({ path, kind: 'data' });
    databases.push(after);
    after.migrate();
    const events: GoalEvent[] = [];
    const recoveredStore = new GoalStore(after, event => {
      expect(after.sqlite.inTransaction).toBe(false);
      events.push(event);
    });
    recoveredStore.pauseActiveOnStartup();
    const recovered = recoveredStore.getCurrent('active')!;
    expect(recovered).toMatchObject({ id: active.id, status: 'paused', version: active.version + 1 });
    expect(recovered.updatedAt).toBeGreaterThanOrEqual(active.updatedAt);
    expect(recoveredStore.getCurrent('paused')).toEqual(paused);
    expect(recoveredStore.get('completed', completed.id)).toEqual(completed);
    recoveredStore.pauseActiveOnStartup();
    expect(events).toEqual([{ type: 'goal_paused', goal: recovered }]);
  });

  it('Session 永久删除级联清理 Goal, 迟到写入不能再恢复记录', () => {
    const { db, store } = makeStore();
    const a = store.create('session', '目标');
    db.sqlite.prepare('DELETE FROM sessions WHERE id = ?').run('session');
    expect(store.listSummaries('session')).toEqual([]);
    expect(() => store.edit(identity(a), '恢复')).toThrow('goal_not_found');
    expect(db.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('SQL 拒绝不存在的 Session 和互相矛盾的终态字段', () => {
    const { db, store } = makeStore();
    const a = store.create('session', '目标');
    const repo = new GoalsRepo(db.sqlite);
    const row = repo.findById('session', a.id)!;
    expect(() => repo.insert({ ...row, id: 'orphan', session_id: 'missing' })).toThrow(/FOREIGN KEY/);
    expect(() => repo.update({ ...row, status: 'completed', completed_at: Date.now() }))
      .toThrow(/CHECK constraint/);
    expect(() => repo.update({ ...row, reason: 'cancelled' })).toThrow(/CHECK constraint/);
    expect(repo.findById('session', a.id)).toEqual(row);
  });
});
