// 测试 Session 续接队列的逐条交付、引导顺序、安全领取与后台轻量通知.
import { describe, expect, it, vi } from 'vitest';
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
    turns: {
      getRunningTurn: () => sessionRunning ? ({ id: 'running-turn' } as never) : undefined,
    },
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
    });
    expect(fixture.starts[0]!.input).toEqual([{ type: 'text', text: '第一条' }]);
    expect(fixture.attachTurn).toHaveBeenCalledWith(expect.anything(), true);

    fixture.queue.acknowledge(fixture.starts[0]!.turnId!);
    fixture.setRunning(false);
    fixture.queue.turnCompleted('session-a');
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
    fixture.queue.turnCompleted('session-a');
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
    fixture.queue.turnCompleted('session-a');
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

    expect(claim).toMatchObject({ type: 'completion_notices' });
    if (claim?.type !== 'completion_notices') throw new Error('应领取后台完成通知');
    expect(claim.completionNoticeText).toContain('Subagent agent-1 已结束, status=completed');
    expect(claim.completionNoticeText).toContain('BackgroundProcess process-1 已结束, status=failed');
    expect(claim.completionNoticeText).toContain('SubagentAwait');
    expect(claim.completionNoticeText).toContain('ProcessOutput');
  });

  it('后台通知和 guided 输入分成两个 claim, 每次确认只消费一条 Message 的来源', () => {
    const fixture = createFixture(true);
    const guided = fixture.queue.enqueue({
      sessionId: 'session-a', input: [{ type: 'text', text: '立即引导' }], selection: workSelection,
    });
    fixture.queue.guide('session-a', guided.id);
    fixture.queue.backgroundProcessCompleted('session-a', 'process-1', 'completed');

    const noticeClaim = fixture.queue.claimNextIteration('session-a', 'active-turn');
    expect(noticeClaim).toMatchObject({ type: 'completion_notices' });
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
});
