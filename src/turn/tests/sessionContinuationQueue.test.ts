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
      getSession: () => ({ ttsEnabled: true, archivedAt: null }) as never,
      getSessionForWork: () => ({ ttsEnabled: true, archivedAt: null }) as never,
    },
    sessionRunning: {
      isRunning: () => sessionRunning,
      isClosed: () => false,
      getRunning: () => sessionRunning ? { kind: 'turn', turnId: 'running-turn' } : undefined,
    },
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

const goalDatabases: Database[] = [];
afterEach(() => {
  for (const db of goalDatabases.splice(0)) db.close();
});

function createGoalFixture() {
  const db = new Database({ memory: true, kind: 'data' });
  db.migrate();
  goalDatabases.push(db);
  const sessionRunning = new SessionRunningRegistry();
  const sessions = new SessionStore({ db, isWorkClosed: id => sessionRunning.isClosed(id) });
  const session = sessions.createSession({ cwd: os.tmpdir() });
  const goals = new GoalStore(db);
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
      queue.workFinished(session.id, 'completed');
    },
  };
}

describe('SessionContinuationQueue', () => {
  it('截图仅在空闲时同步入队, 同一间隙第二次提交被拒绝', async () => {
    const { queue, starts } = createFixture();
    const input = {
      sessionId: 'session-a',
      input: [{ type: 'attachment' as const, block: { type: 'image_reference' as const, path: '/screen.png', name: '屏幕截图' } }],
    };
    expect(queue.isIdleForVishotCapture('session-a')).toBe(true);
    expect(queue.enqueueIfIdleForVishotCapture(input)).toBe(true);
    expect(queue.enqueueIfIdleForVishotCapture(input)).toBe(false);
    await Promise.resolve();
    expect(starts).toHaveLength(1);
    expect(starts[0]!.input).toEqual(input.input);
  });

  it.each(['turn', 'compact', 'input', 'notice', 'goal', 'drain', 'closed'] as const)('%s 不允许自动截图插队', async reason => {
    const f = createGoalFixture();
    const id = f.session.id;
    if (reason === 'turn') f.sessionRunning.register(id, { kind: 'turn', turnId: 'busy' });
    if (reason === 'compact') f.sessionRunning.register(id, { kind: 'compact', compactId: 'busy' });
    if (reason === 'input') f.queue.enqueue({ sessionId: id, input: [{ type: 'text', text: '先处理用户输入' }] });
    if (reason === 'notice') f.queue.backgroundProcessCompleted(id, 'p', 'completed');
    if (reason === 'goal') f.goals.create(id, '未完成目标');
    if (reason === 'drain') f.queue.requestDrain(id);
    if (reason === 'closed') f.queue.shutdown();
    expect(f.queue.isIdleForVishotCapture(id)).toBe(false);
    expect(f.queue.enqueueIfIdleForVishotCapture({ sessionId: id, input: [] })).toBe(false);
    f.queue.shutdown();
  });

  it('归档取消输入与续接, 忽略迟到的完成通知, 取消归档不重放队列', async () => {
    const fixture = createGoalFixture();
    fixture.queue.enqueue({ sessionId: fixture.session.id, input: [{ type: 'text', text: '未执行' }] });
    fixture.queue.subagentCompleted(fixture.session.id, 'child', 'completed');
    await fixture.sessionRunning.runWithSessionClosed(fixture.session.id, async () => {
      expect(() => fixture.queue.enqueue({ sessionId: fixture.session.id, input: [{ type: 'text', text: '迟到输入' }] }))
        .toThrow('session_stopping');
      fixture.sessions.archiveSession(fixture.session.id);
      fixture.queue.clearSession(fixture.session.id);
      fixture.queue.workFinished(fixture.session.id, 'completed');
      fixture.queue.backgroundProcessCompleted(fixture.session.id, 'process', 'completed');
      fixture.queue.subagentCompleted(fixture.session.id, 'late-child', 'cancelled');
    });
    expect(() => fixture.queue.enqueue({ sessionId: fixture.session.id, input: [{ type: 'text', text: '归档输入' }] }))
      .toThrow('session_archived');
    expect(fixture.starts).toEqual([]);
    expect(fixture.queue.list(fixture.session.id)).toEqual([]);
    fixture.sessions.unarchiveSession(fixture.session.id);
    fixture.queue.requestDrain(fixture.session.id);
    await Promise.resolve();
    expect(fixture.starts).toEqual([]);
    expect(fixture.queue.claimNextIteration(fixture.session.id, 'next')).toBeUndefined();
  });

  it.each(['idle', 'compact'] as const)('%s 时编辑 active Goal 只保存, 不领取隐藏消息或启动 Turn', async mode => {
    const fixture = createGoalFixture();
    const created = fixture.goals.create(fixture.session.id, '原目标');
    if (mode === 'compact') fixture.sessionRunning.register(fixture.session.id, { kind: 'compact', compactId: 'compact' });
    const edited = fixture.goals.edit({ sessionId: created.sessionId, goalId: created.id, expectedVersion: created.version }, '新目标');
    fixture.queue.goalEdited(edited);
    await Promise.resolve();
    expect(fixture.starts).toHaveLength(0);
    expect(fixture.queue.claimNextIteration(fixture.session.id, 'turn')).toBeUndefined();
    expect(fixture.queue.list(fixture.session.id)).toEqual([]);
    expect(fixture.goals.getCurrent(fixture.session.id)?.objective).toBe('新目标');
    fixture.queue.shutdown();
  });

  it('Goal 编辑领取可重试, 后到编辑不被旧确认删除, 只绑定原Turn', () => {
    const fixture = createGoalFixture();
    fixture.sessionRunning.register(fixture.session.id, { kind: 'turn', turnId: 'root' });
    const original = fixture.goals.create(fixture.session.id, '原目标');
    const edited = fixture.goals.edit({ sessionId: original.sessionId, goalId: original.id, expectedVersion: original.version }, '第一版');
    fixture.queue.goalEdited(edited);
    expect(fixture.queue.claimNextIteration(fixture.session.id, 'other-turn')).toBeUndefined();
    const first = fixture.queue.claimNextIteration(fixture.session.id, 'root');
    fixture.queue.release('root');
    expect(fixture.queue.claimNextIteration(fixture.session.id, 'root')).toEqual(first);
    const latest = fixture.goals.edit({ sessionId: edited.sessionId, goalId: edited.id, expectedVersion: edited.version }, '第二版');
    fixture.queue.goalEdited(latest);
    fixture.queue.acknowledge('root');
    expect(fixture.queue.claimNextIteration(fixture.session.id, 'root')).toMatchObject({
      type: 'continuation', continuationText: expect.stringContaining('第二版'),
    });
    fixture.queue.acknowledge('root');
    expect(fixture.queue.claimNextIteration(fixture.session.id, 'root')).toBeUndefined();
    fixture.queue.shutdown();
  });

  it.each(['pause', 'cancel', 'delete'] as const)('编辑后 %s Goal 不再注入旧目标正文', action => {
    const fixture = createGoalFixture();
    fixture.sessionRunning.register(fixture.session.id, { kind: 'turn', turnId: 'root' });
    const original = fixture.goals.create(fixture.session.id, '原目标');
    const edited = fixture.goals.edit({ sessionId: original.sessionId, goalId: original.id, expectedVersion: original.version }, '新目标');
    fixture.queue.goalEdited(edited);
    fixture.goals[action]({ sessionId: edited.sessionId, goalId: edited.id, expectedVersion: edited.version });
    expect(fixture.queue.claimNextIteration(fixture.session.id, 'root')).toBeUndefined();
    fixture.queue.workFinished(fixture.session.id, 'aborted');
    expect(fixture.queue.claimNextIteration(fixture.session.id, 'root')).toBeUndefined();
    fixture.queue.shutdown();
  });

  it('领取时合并全部已有输入, 后到输入留给下一 Turn', async () => {
    const fixture = createFixture();
    const first = fixture.queue.enqueue({
      sessionId: 'session-a',
      input: [{ type: 'text', text: '第一条' }],
    });
    const second = fixture.queue.enqueue({
      sessionId: 'session-a',
      input: [{ type: 'text', text: '第二条' }],
    });

    await Promise.resolve();

    expect(fixture.starts).toHaveLength(1);
    expect(fixture.starts[0]).toMatchObject({
      triggerType: 'userMessage',
      ttsEnabled: true,
    });
    expect(fixture.starts[0]!.input).toEqual([{ type: 'text', text: '第一条\n\n第二条' }]);
    expect(fixture.attachTurn).toHaveBeenCalledWith(expect.anything());

    fixture.queue.enqueue({ sessionId: 'session-a', input: [{ type: 'text', text: '后到' }] });
    expect(fixture.queue.acknowledge(fixture.starts[0]!.turnId!)).toEqual([first.id, second.id]);
    fixture.setRunning(false);
    fixture.queue.workFinished('session-a', 'completed');
    await Promise.resolve();

    expect(fixture.starts).toHaveLength(2);
    expect(fixture.starts[1]!.input).toEqual([{ type: 'text', text: '后到' }]);
    expect(fixture.events.filter(({ event }) => event.type === 'queued_input_removed')).toHaveLength(0);
  });

  it('活动 Turn 只领取 next_iteration 输入, 普通输入留到 Turn 清理以后', async () => {
    const fixture = createFixture(true);
    const normal = fixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '稍后' }],
    });
    const guided = fixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '立即' }],
    });
    fixture.queue.guide('session-a', guided.id);

    const claim = fixture.queue.claimNextIteration('session-a', 'active-turn');
    expect(claim).toMatchObject({ type: 'user_input', input: guided.input });
    expect(fixture.queue.acknowledge('active-turn')).toEqual([guided.id]);
    expect(fixture.queue.list('session-a').map(item => item.id)).toEqual([normal.id]);

    fixture.setRunning(false);
    fixture.queue.workFinished('session-a', 'completed');
    await Promise.resolve();
    expect(fixture.starts).toHaveLength(1);
    expect(fixture.starts[0]!.input).toEqual([{ type: 'text', text: '稍后' }]);
  });

  it('多条引导按提交顺序合并领取, 普通排队不混入当前迭代', () => {
    const fixture = createFixture(true);
    const first = fixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '第一条' }],
    });
    const second = fixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '第二条' }],
    });
    const third = fixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '第三条' }],
    });

    expect(fixture.queue.guide('session-a', second.id)).toBe(true);
    expect(fixture.queue.guide('session-a', first.id)).toBe(true);
    expect(fixture.queue.claimNextIteration('session-a', 'active-turn'))
      .toMatchObject({ type: 'user_input', input: [{ type: 'text', text: '第一条\n\n第二条' }] });
    fixture.queue.release('active-turn');
    expect(fixture.queue.list('session-a').map(item => item.id)).toEqual([first.id, second.id, third.id]);
    expect(fixture.queue.list('session-a').find(item => item.id === third.id)?.delivery).toBe('after_turn');
    fixture.queue.claimNextIteration('session-a', 'active-turn');
    expect(fixture.queue.acknowledge('active-turn')).toEqual([first.id, second.id]);
    expect(fixture.queue.claimNextIteration('session-a', 'active-turn')).toBeUndefined();
  });

  it('同一 item 只能引导一次, 引导后不能再删除或重复发布事件', () => {
    const fixture = createFixture(true);
    const item = fixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '立即' }],
    });

    expect(fixture.queue.guide('session-a', item.id)).toBe(true);
    expect(fixture.queue.guide('session-a', item.id)).toBe(false);
    expect(fixture.queue.remove('session-a', item.id)).toBe(false);
    expect(fixture.events.filter(({ event }) => event.type === 'queued_input_guided')).toHaveLength(1);
  });

  it('正常结束时未保存的引导与普通排队一起进入下一 Turn', async () => {
    const fixture = createFixture(true);
    fixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '普通' }],
    });
    const guided = fixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '引导' }],
    });
    fixture.queue.guide('session-a', guided.id);

    fixture.setRunning(false);
    fixture.queue.workFinished('session-a', 'completed');
    await Promise.resolve();

    expect(fixture.starts[0]!.input).toEqual([{ type: 'text', text: '普通\n\n引导' }]);
  });

  it('确认保存返回输入 ID, 不额外发送提前移除消息的事件', async () => {
    const normalFixture = createFixture();
    const normal = normalFixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '普通' }],
    });
    await Promise.resolve();
    expect(normalFixture.queue.acknowledge(normalFixture.starts[0]!.turnId!)).toEqual([normal.id]);
    expect(normalFixture.events.filter(({ event }) => event.type === 'queued_input_removed')).toHaveLength(0);

    const guidedFixture = createFixture(true);
    const guided = guidedFixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '引导' }],
    });
    guidedFixture.queue.guide('session-a', guided.id);
    guidedFixture.queue.claimNextIteration('session-a', 'active-turn');
    expect(guidedFixture.queue.acknowledge('active-turn')).toEqual([guided.id]);
    expect(guidedFixture.queue.acknowledge('active-turn')).toEqual([]);
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
      sessionId: 'session-a', input: [{ type: 'text', text: '立即引导' }],
    });
    fixture.queue.guide('session-a', guided.id);
    fixture.queue.backgroundProcessCompleted('session-a', 'process-1', 'completed');

    const noticeClaim = fixture.queue.claimNextIteration('session-a', 'active-turn');
    expect(noticeClaim).toMatchObject({ type: 'continuation' });
    fixture.queue.acknowledge('active-turn');

    const inputClaim = fixture.queue.claimNextIteration('session-a', 'active-turn');
    expect(inputClaim).toMatchObject({
      type: 'user_input',
      input: guided.input,
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
      input: [{ type: 'text', text: '先处理用户消息' }] });
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
      input: [{ type: 'text', text: '用户消息仍然有效' }] });
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
      input: [{ type: 'text', text: '立即引导' }] });
    fixture.queue.guide(fixture.session.id, item.id);
    const claim = fixture.queue.claimNextIteration(fixture.session.id, 'running-turn');
    expect(claim).toMatchObject({ type: 'user_input', input: item.input });
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

  it.each(['failed', 'aborted'] as const)('%s 把所有未保存输入按顺序退回, 清空后不重试', async status => {
    const fixture = createFixture();
    const first = fixture.queue.enqueue({ sessionId: 'session-a', input: [{ type: 'text', text: '不能丢' }] });
    await Promise.resolve();
    const second = fixture.queue.enqueue({ sessionId: 'session-a', input: [{ type: 'text', text: '补充' }] });
    fixture.queue.guide('session-a', second.id);
    fixture.queue.release(fixture.starts[0]!.turnId!);
    fixture.setRunning(false);
    fixture.queue.workFinished('session-a', status);
    await Promise.resolve();
    expect(fixture.starts).toHaveLength(1);
    expect(fixture.queue.list('session-a')).toHaveLength(0);
    expect(fixture.events.at(-1)?.event).toEqual({
      type: 'queued_inputs_returned',
      items: [first, { ...second, delivery: 'next_iteration' }],
    });
    fixture.queue.requestDrain('session-a');
    await Promise.resolve();
    expect(fixture.starts).toHaveLength(1);
  });

  it.each(['shutdown', 'deleteSession'] as const)('已有唤醒时 %s, 不再启动 Goal Turn', async action => {
    const fixture = createGoalFixture();
    fixture.goals.create(fixture.session.id, '不可复活');
    fixture.queue.requestDrain(fixture.session.id);
    if (action === 'shutdown') fixture.queue.shutdown();
    else {
      fixture.queue.clearSession(fixture.session.id);
      fixture.sessions.deleteSession(fixture.session.id);
    }
    await Promise.resolve();
    expect(fixture.starts).toHaveLength(0);
  });
});
