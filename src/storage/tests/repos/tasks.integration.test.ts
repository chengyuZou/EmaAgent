// 验证持久 Task 的 CAS 更新与低频提醒两阶段提交。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TasksRepo } from '../../repos/data/tasks.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('Task 持久化边界', () => {
  let database: TestDatabase;
  let tasks: TasksRepo;

  const sessionId = 'session-task';
  const turnId = 'turn-task';
  const taskA = 'task-a';
  const taskB = 'task-b';

  beforeEach(() => {
    database = createTestDatabase();
    database.db.prepare(`
      INSERT INTO sessions (id, title, created_at, updated_at)
      VALUES (?, 'Task session', 1, 1)
    `).run(sessionId);
    database.db.prepare(`
      INSERT INTO turns (
        id, session_id, trigger_type, execution_profile, narrative_policy,
        status, created_at
      ) VALUES (?, ?, 'userMessage', 'work', 'auto', 'running', 2)
    `).run(turnId, sessionId);

    tasks = new TasksRepo(database.db);
    createTask(taskA, 'First task', 3);
    createTask(taskB, 'Second task', 4);
  });

  afterEach(() => database.close());

  it('为 Session 分配短序号，并拒绝陈旧 version 覆盖新值', () => {
    expect(tasks.listForSession(sessionId).map((task) => task.display_number))
      .toEqual([1, 2]);

    expect(tasks.mutate(mutation(taskA, 0, {
      patch: { subject: 'Updated first task' },
    }))).toMatchObject({
      ok: true,
      changed: true,
      row: { version: 1, subject: 'Updated first task' },
    });
    expect(tasks.mutate(mutation(taskA, 0, {
      patch: { subject: 'Stale title' },
    }))).toMatchObject({
      ok: false,
      reason: 'version_conflict',
      current: { version: 1, subject: 'Updated first task' },
    });
  });

  it('完成/取消任务写入 completed 字段，幂等写不重复 bump version', () => {
    expect(tasks.mutate(mutation(taskB, 0, {
      patch: { status: 'completed', completedByTurnId: turnId, completedAt: 6 },
    }))).toMatchObject({
      ok: true,
      changed: true,
      row: { status: 'completed', version: 1, completed_by_turn_id: turnId },
    });
    expect(tasks.mutate(mutation(taskB, 1, {
      patch: { status: 'completed', completedByTurnId: turnId, completedAt: 6 },
    }))).toMatchObject({ ok: true, changed: false, row: { version: 1 } });
  });

  it('低频提醒先只检查不消费，markReminded 后才推进周期', () => {
    for (let index = 0; index < 10; index += 1) {
      database.db.prepare(`
        INSERT INTO turns (
          id, session_id, trigger_type, execution_profile, narrative_policy,
          status, created_at
        ) VALUES (?, ?, 'userMessage', 'work', 'auto', 'completed', ?)
      `).run(`turn-reminder-${index}`, sessionId, 5 + index);
    }

    // 达到周期：只检查不写状态，重复检查仍通过（不消费）。
    expect(tasks.shouldRemind(sessionId, 10)).toBe(true);
    expect(tasks.shouldRemind(sessionId, 10)).toBe(true);

    // 显式提交已提醒：周期推进，后续不再提醒。
    tasks.markReminded(sessionId, 20);
    expect(tasks.shouldRemind(sessionId, 10)).toBe(false);
  });

  function createTask(id: string, subject: string, createdAt: number): void {
    tasks.create({
      id,
      sessionId,
      subject,
      description: `${subject} description`,
      createdByTurnId: turnId,
      createdAt,
    });
  }

  function mutation(
    id: string,
    expectedVersion: number,
    overrides: Partial<Parameters<TasksRepo['mutate']>[0]>,
  ): Parameters<TasksRepo['mutate']>[0] {
    return {
      id,
      sessionId,
      expectedVersion,
      patch: {},
      updatedAt: 20,
      ...overrides,
    };
  }
});
