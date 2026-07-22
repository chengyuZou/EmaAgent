// 测试根 Agent Turn 与 AgentTask 会在同一事务中创建和结束，任一写入失败都会整体回滚。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTaskStore } from '@ema-agent/agent-task';
import { SessionStore } from '@ema-agent/session';
import { AgentTasksRepo, Database } from '@ema-agent/storage';
import { AgentTurnLifecycleFacade } from '../src/turn-runtime/agent-turn-lifecycle.js';
import { AgentTurnLifecycleError } from '../src/turn-runtime/errors.js';

describe('AgentTurnLifecycleFacade', () => {
  let database: Database;
  let session: SessionStore;
  let tasks: AgentTaskStore;
  let lifecycle: AgentTurnLifecycleFacade;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'data' });
    database.migrate();
    session = new SessionStore({ db: database });
    tasks = new AgentTaskStore(new AgentTasksRepo(database.sqlite));
    lifecycle = new AgentTurnLifecycleFacade(
      session,
      tasks,
      <T>(work: () => T): T => database.sqlite.transaction(work)(),
    );
  });

  afterEach(() => database.close());

  it('原子创建根 Turn 与同 ID 的 running Task，再原子完成两者', () => {
    const owner = session.createSession();
    const { turn } = lifecycle.start({
      sessionId: owner.id,
      triggerType: 'userMessage',
      executionProfile: 'work',
      narrativePolicy: 'off',
      userInput: 'run',
    });

    expect(tasks.get(turn.id)).toMatchObject({
      id: turn.id,
      sessionId: owner.id,
      turnId: turn.id,
      parentId: null,
      status: 'running',
    });

    lifecycle.complete({
      turnId: turn.id,
      iterations: 3,
      inputTokens: 40,
      outputTokens: 20,
    });

    expect(session.getTurn(turn.id)).toMatchObject({
      status: 'completed',
      iterations: 3,
      usageInputTokens: 40,
      usageOutputTokens: 20,
    });
    expect(tasks.get(turn.id)).toMatchObject({ status: 'completed' });
  });

  it('Task CAS 冲突时不单独提交 Turn 终态', () => {
    const owner = session.createSession();
    const { turn } = lifecycle.start({
      sessionId: owner.id,
      triggerType: 'userMessage',
      executionProfile: 'work',
      narrativePolicy: 'off',
      userInput: 'run',
    });
    expect(tasks.cancel(turn.id, 'external_cancel').ok).toBe(true);

    expect(() => lifecycle.complete({
      turnId: turn.id,
      iterations: 1,
      inputTokens: 1,
      outputTokens: 1,
    })).toThrow(AgentTurnLifecycleError);

    expect(session.getTurn(turn.id)?.status).toBe('running');
    expect(tasks.get(turn.id)?.status).toBe('cancelled');
  });

  it('Turn 写入失败时回滚已经成功的 Task 转换', () => {
    const owner = session.createSession();
    const { turn } = lifecycle.start({
      sessionId: owner.id,
      triggerType: 'userMessage',
      executionProfile: 'work',
      narrativePolicy: 'off',
      userInput: 'run',
    });
    vi.spyOn(session, 'completeTurn').mockImplementation(() => {
      throw new Error('simulated turn write failure');
    });

    expect(() => lifecycle.complete({
      turnId: turn.id,
      iterations: 1,
      inputTokens: 1,
      outputTokens: 1,
    })).toThrow('simulated turn write failure');

    expect(session.getTurn(turn.id)?.status).toBe('running');
    expect(tasks.get(turn.id)?.status).toBe('running');
  });

  it('失败与取消分别同步为 failed 和 aborted/cancelled', () => {
    const failedOwner = session.createSession();
    const failed = lifecycle.start({
      sessionId: failedOwner.id,
      triggerType: 'userMessage',
      executionProfile: 'work',
      narrativePolicy: 'off',
      userInput: 'fail',
    });
    lifecycle.fail({
      turnId: failed.turn.id,
      code: 'turn/execution_failed',
      message: 'provider failed',
    });
    expect(session.getTurn(failed.turn.id)?.status).toBe('failed');
    expect(tasks.get(failed.turn.id)).toMatchObject({
      status: 'failed',
      error: 'provider failed',
    });

    const abortedOwner = session.createSession();
    const aborted = lifecycle.start({
      sessionId: abortedOwner.id,
      triggerType: 'userMessage',
      executionProfile: 'work',
      narrativePolicy: 'off',
      userInput: 'abort',
    });
    session.requestAbort(abortedOwner.id);
    lifecycle.abort({
      sessionId: abortedOwner.id,
      turnId: aborted.turn.id,
      reason: 'user_abort',
    });
    expect(aborted.signal.aborted).toBe(true);
    expect(session.getTurn(aborted.turn.id)?.status).toBe('aborted');
    expect(tasks.get(aborted.turn.id)?.status).toBe('cancelled');
  });
});
