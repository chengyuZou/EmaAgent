// 验证持久 Task 的 CAS、依赖图和 AgentRun 绑定不会产生互相矛盾的状态。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRunsRepo } from '../../repos/data/agent-runs.js';
import { TasksRepo } from '../../repos/data/tasks.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('Task 持久化边界', () => {
  let database: TestDatabase;
  let tasks: TasksRepo;
  let runs: AgentRunsRepo;

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
    runs = new AgentRunsRepo(database.db);
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

  it('阻止依赖环、阻塞状态跃迁和给运行中 Task 新增未完成依赖', () => {
    expect(tasks.mutate(mutation(taskB, 0, {
      addBlockedBy: [taskA],
    }))).toMatchObject({ ok: true, row: { version: 1 } });

    expect(tasks.mutate(mutation(taskB, 1, {
      patch: { status: 'in_progress' },
    }))).toMatchObject({ ok: false, reason: 'blocked' });

    expect(tasks.mutate(mutation(taskA, 0, {
      addBlockedBy: [taskB],
    }))).toMatchObject({ ok: false, reason: 'dependency_cycle' });

    expect(tasks.mutate(mutation(taskB, 1, {
      patch: { status: 'in_progress' },
      removeBlockedBy: [taskA],
    }))).toMatchObject({
      ok: true,
      row: { status: 'in_progress', version: 2 },
    });

    const taskC = 'task-c';
    createTask(taskC, 'Running task', 5);
    expect(tasks.mutate(mutation(taskC, 0, {
      patch: { status: 'in_progress' },
    }))).toMatchObject({ ok: true, row: { version: 1 } });
    expect(tasks.mutate(mutation(taskC, 1, {
      addBlockedBy: [taskA],
    }))).toMatchObject({ ok: false, reason: 'blocked' });
  });

  it('AgentRun 只能绑定可执行 Task，且 Run 完成不会隐式完成 Task', () => {
    expect(tasks.mutate(mutation(taskB, 0, {
      addBlockedBy: [taskA],
    }))).toMatchObject({ ok: true });

    expect(() => runs.insert({
      id: 'run-blocked',
      sessionId,
      parentTurnId: turnId,
      taskId: taskB,
      contextMode: 'subagent',
      createdAt: 5,
    })).toThrow(/unresolved dependency/);

    expect(tasks.mutate(mutation(taskA, 0, {
      patch: {
        status: 'completed',
        completedByTurnId: turnId,
        completedAt: 6,
      },
    }))).toMatchObject({ ok: true });

    const runId = 'run-active';
    expect(runs.insert({
      id: runId,
      sessionId,
      parentTurnId: turnId,
      taskId: taskB,
      contextMode: 'subagent',
      createdAt: 7,
    })).toMatchObject({ status: 'running', task_id: taskB });
    expect(runs.insert({
      id: 'run-second',
      sessionId,
      parentTurnId: turnId,
      taskId: taskB,
      contextMode: 'subagent',
      createdAt: 8,
    })).toBeUndefined();

    expect(tasks.mutate(mutation(taskB, 1, {
      patch: {
        status: 'completed',
        completedByTurnId: turnId,
        completedAt: 9,
      },
    }))).toMatchObject({ ok: false, reason: 'active_agent_run' });

    expect(runs.complete(runId, 0, {
      iterations: 1,
      toolCallCount: 0,
      inputTokens: 10,
      outputTokens: 20,
    }, 10)).toMatchObject({ status: 'completed' });
    expect(tasks.findById(taskB, sessionId)).toMatchObject({ status: 'pending' });
  });

  it('动态提醒按 Turn 数低频触发，并在触发后重新计数', () => {
    for (let index = 0; index < 10; index += 1) {
      database.db.prepare(`
        INSERT INTO turns (
          id, session_id, trigger_type, execution_profile, narrative_policy,
          status, created_at
        ) VALUES (?, ?, 'userMessage', 'work', 'auto', 'completed', ?)
      `).run(`turn-reminder-${index}`, sessionId, 5 + index);
    }

    expect(tasks.shouldRemind(sessionId, 10, 20)).toBe(true);
    expect(tasks.shouldRemind(sessionId, 10, 21)).toBe(false);
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
      addBlocks: [],
      addBlockedBy: [],
      removeBlocks: [],
      removeBlockedBy: [],
      updatedAt: 20,
      ...overrides,
    };
  }
});
