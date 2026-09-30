// 测试 Session 续接队列的逐条交付、引导顺序、安全领取与后台轻量通知.
import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { GoalStore } from '@ema-agent/goal';
import { SessionRunningRegistry, SessionStore } from '@ema-agent/session';
import { Database } from '@ema-agent/storage';
import type { StartTurn, TurnHandle } from '../types.js';
import { SessionContinuationQueue } from '../sessionContinuationQueue.js';

function makeHandle(input: StartTurn): TurnHandle {
  return {
    sessionId: input.sessionId,
    turnId: input.turnId!,
    events: (async function* () {})(),
    completion: new Promise(() => {}),
    abort: () => undefined,
  };
}

function createFixture(running = false) {
  let sessionRunning = running;
  const starts: StartTurn[] = [];
  const attachTurn = vi.fn();
  const events: Array<{ sessionId: string; event: Parameters<ConstructorParameters<typeof SessionContinuationQueue>[0]['publish']>[1] }> = [];
  const queue = new SessionContinuationQueue({
    sessions: {
      sessionExists: sessionId => sessionId === 'session-a',
      getSession: () => ({ sessionMode: 'chat', narrativePolicy: 'off', ttsEnabled: true }) as never,
    },
    sessionRunning: { isRunning: () => sessionRunning },
    goals: { getCurrent: () => null },
    startTurn: input => {
      starts.push(input);
      sessionRunning = true;
      return makeHandle(input);
    },
    attachTurn,
    publish: (sessionId, event) => events.push({ sessionId, event }),
  });
  return {
    queue,
    starts,
    attachTurn,
    events,
    setRunning(value: boolean) { sessionRunning = value; },
  };
}

const workSelection = {
  sessionMode: 'work' as const,
  narrativePolicy: 'always' as const,
};

const goalDatabases: Database[] = [];
afterEach(() => {
  for (const db of goalDatabases.splice(0)) db.close();
});

function createGoalFixture() {
  const db = new Database({ memory: true, kind: 'data' });
  db.migrate();
  goalDatabases.push(db);
  const sessions = new SessionStore({ db });
  const session = sessions.createSession({ cwd: os.tmpdir() });
  const goals = new GoalStore(db);
  const sessionRunning = new SessionRunningRegistry();
  const starts: StartTurn[] = [];
  const queue = new SessionContinuationQueue({
    sessions, goals, sessionRunning,
    startTurn: input => {
      sessionRunning.register(input.sessionId, { kind: 'turn', turnId: input.turnId! });
      starts.push(input);
      return makeHandle(input);
    },
    attachTurn: () => undefined,
    publish: () => undefined,
  });
  return {
    db, sessions, session, goals, sessionRunning, starts, queue,
    finish(index: number) {
      const turnId = starts[index]!.turnId!;
      queue.acknowledge(turnId);
      sessionRunning.clear(session.id, { kind: 'turn', turnId });
      queue.turnFinished(session.id, 'completed');
    },
  };
}

describe('SessionContinuationQueue', () => {
  it('普通排队输入按入队顺序逐条启动 Turn, 不再合并消息', async () => {
    const fixture = createFixture();
    const first = fixture.queue.enqueue({
      sessionId: 'session-a',
      input: [{ type: 'text', text: '第一条' }],
      selection: { sessionMode: 'chat', narrativePolicy: 'off' },
    });
    fixture.queue.enqueue({
      sessionId: 'session-a',
      input: [{ type: 'text', text: '第二条' }],
      selection: workSelection,
    });

    await Promise.resolve();

    expect(fixture.starts).toHaveLength(1);
    expect(fixture.starts[0]).toMatchObject({
      triggerType: 'userMessage',
      sessionMode: 'work',
      narrativePolicy: 'always',
      ttsEnabled: true,
    });
    expect(fixture.starts[0]!.input).toEqual([{ type: 'text', text: '第一条' }]);
    expect(fixture.attachTurn).toHaveBeenCalledWith(expect.anything());

    fixture.queue.acknowledge(fixture.starts[0]!.turnId!);
    fixture.setRunning(false);
    fixture.queue.turnFinished('session-a', 'completed');
    await Promise.resolve();

    expect(fixture.starts).toHaveLength(2);
    expect(fixture.starts[1]!.input).toEqual([{ type: 'text', text: '第二条' }]);
    expect(fixture.events.filter(({ event }) => (
      event.type === 'queued_input_removed' && event.id === first.id
    ))).toHaveLength(1);
  });

  it('活动 Turn 只领取 next_iteration 输入, 普通输入留到 Turn 清理以后', async () => {
    const fixture = createFixture(true);
    const normal = fixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '稍后' }], selection: workSelection,
    });
    const guided = fixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '立即' }], selection: workSelection,
    });
    fixture.queue.guide('session-a', guided.id);

    const claim = fixture.queue.claimNextIteration('session-a', 'active-turn');
    expect(claim).toMatchObject({ type: 'user_input', userInput: { id: guided.id } });
    fixture.queue.acknowledge('active-turn');
    expect(fixture.queue.list('session-a').map(item => item.id)).toEqual([normal.id]);

    fixture.setRunning(false);
    fixture.queue.turnFinished('session-a', 'completed');
    await Promise.resolve();
    expect(fixture.starts).toHaveLength(1);
    expect(fixture.starts[0]!.input).toEqual([{ type: 'text', text: '稍后' }]);
  });

  it('多条引导按 guide 成功顺序逐条领取, guided 整体优先于普通排队', async () => {
    const fixture = createFixture(true);
    const first = fixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '第一条' }], selection: workSelection,
    });
    const second = fixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '第二条' }], selection: workSelection,
    });
    const third = fixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '第三条' }], selection: workSelection,
    });

    expect(fixture.queue.guide('session-a', second.id)).toBe(true);
    expect(fixture.queue.guide('session-a', first.id)).toBe(true);
    expect(fixture.queue.claimNextIteration('session-a', 'active-turn'))
      .toMatchObject({ type: 'user_input', userInput: { id: second.id } });
    fixture.queue.acknowledge('active-turn');
    expect(fixture.queue.claimNextIteration('session-a', 'active-turn'))
      .toMatchObject({ type: 'user_input', userInput: { id: first.id } });
    fixture.queue.release('active-turn');
    expect(fixture.queue.list('session-a').map(item => item.id)).toEqual([third.id, first.id]);
    expect(fixture.queue.list('session-a').find(item => item.id === third.id)?.delivery).toBe('after_turn');
  });

  it('同一 item 只能引导一次, 引导后不能再删除或重复发布事件', () => {
    const fixture = createFixture(true);
    const item = fixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '立即' }], selection: workSelection,
    });

    expect(fixture.queue.guide('session-a', item.id)).toBe(true);
    expect(fixture.queue.guide('session-a', item.id)).toBe(false);
    expect(fixture.queue.remove('session-a', item.id)).toBe(false);
    expect(fixture.events.filter(({ event }) => event.type === 'queued_input_guided')).toHaveLength(1);
  });

  it('新 Turn 排水优先领取最早成功引导的一条', async () => {
    const fixture = createFixture(true);
    fixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '普通' }], selection: workSelection,
    });
    const guided = fixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '引导' }], selection: workSelection,
    });
    fixture.queue.guide('session-a', guided.id);

    fixture.setRunning(false);
    fixture.queue.turnFinished('session-a', 'completed');
    await Promise.resolve();

    expect(fixture.starts[0]!.input).toEqual([{ type: 'text', text: '引导' }]);
  });

  it('acknowledge 只为普通排队项发布 removed, guided 已由 guided 事件离开等待区', async () => {
    const normalFixture = createFixture();
    normalFixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '普通' }], selection: workSelection,
    });
    await Promise.resolve();
    normalFixture.queue.acknowledge(normalFixture.starts[0]!.turnId!);
    expect(normalFixture.events.filter(({ event }) => event.type === 'queued_input_removed')).toHaveLength(1);

    const guidedFixture = createFixture(true);
    const guided = guidedFixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '引导' }], selection: workSelection,
    });
    guidedFixture.queue.guide('session-a', guided.id);
    guidedFixture.queue.claimNextIteration('session-a', 'active-turn');
    guidedFixture.queue.acknowledge('active-turn');
    expect(guidedFixture.events.filter(({ event }) => event.type === 'queued_input_removed')).toHaveLength(0);
  });

  it('后台终态只注入执行 id 和状态, 不复制完整结果', () => {
    const fixture = createFixture(true);
    fixture.queue.subagentCompleted('session-a', 'agent-1', 'completed');
    fixture.queue.backgroundProcessCompleted('session-a', 'process-1', 'failed');

    const claim = fixture.queue.claimNextIteration('session-a', 'active-turn');

    expect(claim).toMatchObject({ type: 'continuation' });
    if (claim?.type !== 'continuation') throw new Error('应领取后台完成通知');
    expect(claim.continuationText).toContain('Subagent agent-1 已结束, status=completed');
    expect(claim.continuationText).toContain('BackgroundProcess process-1 已结束, status=failed');
    expect(claim.continuationText).toContain('SubagentAwait');
    expect(claim.continuationText).toContain('ProcessOutput');
  });

  it('后台通知和 guided 输入分成两个 claim, 每次确认只消费一条 Message 的来源', () => {
    const fixture = createFixture(true);
    const guided = fixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '立即引导' }], selection: workSelection,
    });
    fixture.queue.guide('session-a', guided.id);
    fixture.queue.backgroundProcessCompleted('session-a', 'process-1', 'completed');

    const noticeClaim = fixture.queue.claimNextIteration('session-a', 'active-turn');
    expect(noticeClaim).toMatchObject({ type: 'continuation' });
    fixture.queue.acknowledge('active-turn');

    const inputClaim = fixture.queue.claimNextIteration('session-a', 'active-turn');
    expect(inputClaim).toMatchObject({
      type: 'user_input',
      userInput: { id: guided.id },
    });
    fixture.queue.acknowledge('active-turn');

    expect(fixture.queue.claimNextIteration('session-a', 'active-turn')).toBeUndefined();
  });

  it('SubagentAwait 读到完整终态后撤掉尚未交付的 Subagent 通知', () => {
    const fixture = createFixture(true);
    fixture.queue.subagentCompleted('session-a', 'agent-1', 'completed');

    fixture.queue.subagentResultRead('session-a', 'agent-1');

    expect(fixture.queue.claimNextIteration('session-a', 'active-turn')).toBeUndefined();
  });

  it('Goal 只在 after-turn 领取, 不在每个迭代生成消息或前端队列卡片', async () => {
    const fixture = createGoalFixture();
    fixture.goals.create(fixture.session.id, '整理 8 个 README');
    expect(fixture.queue.claimNextIteration(fixture.session.id, 'active-turn')).toBeUndefined();
    fixture.queue.requestDrain(fixture.session.id);
    fixture.queue.requestDrain(fixture.session.id);
    fixture.queue.requestDrain(fixture.session.id);
    await Promise.resolve();

    expect(fixture.starts).toHaveLength(1);
    expect(fixture.starts[0]).toMatchObject({
      triggerType: 'sessionContinuation', input: [],
      continuationText: expect.stringContaining('根据本轮 reminder 和 GoalGet'),
    });
    expect(fixture.starts[0]!.continuationText).not.toContain('整理 8 个 README');
    expect(fixture.queue.list(fixture.session.id)).toEqual([]);
    fixture.queue.acknowledge(fixture.starts[0]!.turnId!);
    expect(fixture.goals.getCurrent(fixture.session.id)?.status).toBe('active');
  });

  it('用户输入与 Goal 短提示同轮交付, 后台通知仍保持原来的领取顺序', async () => {
    const fixture = createGoalFixture();
    fixture.goals.create(fixture.session.id, '整理 README');
    fixture.sessionRunning.register(fixture.session.id, { kind: 'compact', compactId: 'compact-a' });
    fixture.queue.enqueue({ sessionId: fixture.session.id,
      input: [{ type: 'text', text: '先处理用户消息' }], selection: workSelection });
    fixture.queue.subagentCompleted(fixture.session.id, 'agent-a', 'completed');
    fixture.sessionRunning.clear(fixture.session.id, { kind: 'compact', compactId: 'compact-a' });
    fixture.queue.requestDrain(fixture.session.id);
    await Promise.resolve();
    expect(fixture.starts[0]!.input).toEqual([{ type: 'text', text: '先处理用户消息' }]);
    expect(fixture.starts[0]!.triggerType).toBe('userMessage');
    expect(fixture.starts[0]!.continuationText).toContain('根据本轮 reminder 和 GoalGet');
    expect(fixture.starts[0]!.continuationText).not.toContain('整理 README');
    fixture.finish(0);
    await Promise.resolve();
    expect(fixture.starts[1]!.continuationText).toContain('Subagent agent-a');
    fixture.finish(1);
    await Promise.resolve();
    expect(fixture.starts[2]!.continuationText).toContain('根据本轮 reminder 和 GoalGet');
  });

  it.each(['pause', 'cancel', 'delete'] as const)('排水微任务前 %s Goal, 用户输入仍交付但不附带 Goal 提示', async action => {
    const fixture = createGoalFixture();
    const goal = fixture.goals.create(fixture.session.id, '已撤销的要求');
    fixture.queue.enqueue({ sessionId: fixture.session.id,
      input: [{ type: 'text', text: '用户消息仍然有效' }], selection: workSelection });
    fixture.goals[action]({ sessionId: fixture.session.id, goalId: goal.id, expectedVersion: goal.version });
    await Promise.resolve();
    expect(fixture.starts).toHaveLength(1);
    expect(fixture.starts[0]!.input).toEqual([{ type: 'text', text: '用户消息仍然有效' }]);
    expect(fixture.starts[0]!.continuationText).toBeUndefined();
  });

  it('active Goal 不给立即引导额外附带续接提示', () => {
    const fixture = createGoalFixture();
    fixture.sessionRunning.register(fixture.session.id, { kind: 'turn', turnId: 'running-turn' });
    fixture.goals.create(fixture.session.id, '持续目标');
    const item = fixture.queue.enqueue({ sessionId: fixture.session.id,
      input: [{ type: 'text', text: '立即引导' }], selection: workSelection });
    fixture.queue.guide(fixture.session.id, item.id);
    const claim = fixture.queue.claimNextIteration(fixture.session.id, 'running-turn');
    expect(claim).toMatchObject({ type: 'user_input', userInput: { id: item.id } });
    expect(claim?.continuationText).toBeUndefined();
  });

  it.each(['pause', 'cancel', 'delete'] as const)('排水微任务执行前 %s Goal, 不使用唤醒时的旧目标', async action => {
    const fixture = createGoalFixture();
    const goal = fixture.goals.create(fixture.session.id, '旧目标');
    fixture.queue.requestDrain(fixture.session.id);
    fixture.goals[action]({ sessionId: fixture.session.id, goalId: goal.id, expectedVersion: goal.version });
    await Promise.resolve();
    expect(fixture.starts).toHaveLength(0);
  });

  it('Compact 占用时不启动, 解锁后同一入口交付 Goal, 完成后不再续接', async () => {
    const fixture = createGoalFixture();
    fixture.sessionRunning.register(fixture.session.id, { kind: 'compact', compactId: 'compact-a' });
    const goal = fixture.goals.create(fixture.session.id, '正在压缩时创建');
    fixture.queue.requestDrain(fixture.session.id);
    await Promise.resolve();
    expect(fixture.starts).toHaveLength(0);
    fixture.sessionRunning.clear(fixture.session.id, { kind: 'compact', compactId: 'compact-a' });
    fixture.queue.requestDrain(fixture.session.id);
    await Promise.resolve();
    expect(fixture.starts).toHaveLength(1);
    fixture.goals.complete({ sessionId: fixture.session.id, goalId: goal.id, expectedVersion: goal.version }, '目标已完成');
    fixture.finish(0);
    await Promise.resolve();
    expect(fixture.starts).toHaveLength(1);
  });

  it('关闭 Goal 不吞后台通知, 重复通知只交付一次, release 后仍可重新领取', async () => {
    const fixture = createGoalFixture();
    const goal = fixture.goals.create(fixture.session.id, '旧目标');
    fixture.sessionRunning.register(fixture.session.id, { kind: 'turn', turnId: 'active-turn' });
    fixture.queue.backgroundProcessCompleted(fixture.session.id, 'process-a', 'completed');
    fixture.queue.backgroundProcessCompleted(fixture.session.id, 'process-a', 'completed');
    fixture.goals.cancel({ sessionId: fixture.session.id, goalId: goal.id, expectedVersion: goal.version });
    const claim = fixture.queue.claimNextIteration(fixture.session.id, 'active-turn');
    expect(claim).toMatchObject({ type: 'continuation', continuationText: expect.stringContaining('process-a') });
    fixture.queue.release('active-turn');
    expect(fixture.queue.claimNextIteration(fixture.session.id, 'active-turn')).toEqual(claim);
    fixture.queue.acknowledge('active-turn');
    expect(fixture.queue.claimNextIteration(fixture.session.id, 'active-turn')).toBeUndefined();
  });

  it.each(['failed', 'aborted'] as const)('%s 不立即重试释放的输入, 下次明确唤醒仍可交付', async status => {
    const fixture = createFixture();
    fixture.queue.enqueue({ sessionId: 'session-a', input: [{ type: 'text', text: '不能丢' }], selection: workSelection });
    await Promise.resolve();
    fixture.queue.release(fixture.starts[0]!.turnId!);
    fixture.setRunning(false);
    fixture.queue.turnFinished('session-a', status);
    await Promise.resolve();
    expect(fixture.starts).toHaveLength(1);
    expect(fixture.queue.list('session-a')).toHaveLength(1);
    fixture.queue.requestDrain('session-a');
    await Promise.resolve();
    expect(fixture.starts).toHaveLength(2);
    expect(fixture.starts[1]!.input).toEqual(fixture.starts[0]!.input);
  });

  it.each(['shutdown', 'deleteSession'] as const)('已有唤醒时 %s, 不再启动 Goal Turn', async action => {
    const fixture = createGoalFixture();
    fixture.goals.create(fixture.session.id, '不可复活');
    fixture.queue.requestDrain(fixture.session.id);
    if (action === 'shutdown') fixture.queue.shutdown();
    else {
      fixture.queue.discardSession(fixture.session.id);
      fixture.sessions.deleteSession(fixture.session.id);
    }
    await Promise.resolve();
    expect(fixture.starts).toHaveLength(0);
  });
});
