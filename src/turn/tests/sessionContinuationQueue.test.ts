// 测试 Session 续接队列的合批、最新运行选择、安全领取与后台轻量通知.
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

function createFixture(active = false) {
  let sessionActive = active;
  const starts: StartTurn[] = [];
  const queue = new SessionContinuationQueue({
    sessions: {
      sessionExists: sessionId => sessionId === 'session-a',
      getSession: () => ({ executionProfile: 'chat', narrativePolicy: 'off' }) as never,
    },
    turns: {
      getActiveTurn: () => sessionActive ? ({ id: 'active-turn' } as never) : undefined,
    },
    startTurn: input => {
      starts.push(input);
      sessionActive = true;
      return makeHandle(input);
    },
    attachTurn: vi.fn(),
    publish: vi.fn(),
  });
  return {
    queue,
    starts,
    setActive(value: boolean) { sessionActive = value; },
  };
}

const workSelection = {
  executionProfile: 'work' as const,
  narrativePolicy: 'always' as const,
  ttsEnabled: true,
};

describe('SessionContinuationQueue', () => {
  it('同一调用栈的多条输入合为一根 Turn, 并使用最近一次输入框选择', async () => {
    const fixture = createFixture();
    fixture.queue.enqueue({
      sessionId: 'session-a',
      input: [{ type: 'text', text: '第一条' }],
      selection: { executionProfile: 'chat', narrativePolicy: 'off', ttsEnabled: false },
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
      executionProfile: 'work',
      narrativePolicy: 'always',
    });
    expect(fixture.starts[0]!.input).toEqual([
      { type: 'text', text: '第一条' },
      { type: 'text', text: '\n\n' },
      { type: 'text', text: '第二条' },
    ]);
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
    expect(claim?.userInputs.map(item => item.id)).toEqual([guided.id]);
    fixture.queue.acknowledge('active-turn');
    expect(fixture.queue.list('session-a').map(item => item.id)).toEqual([normal.id]);

    fixture.setActive(false);
    fixture.queue.turnCompleted('session-a');
    await Promise.resolve();
    expect(fixture.starts).toHaveLength(1);
    expect(fixture.starts[0]!.input).toEqual([{ type: 'text', text: '稍后' }]);
  });

  it('后台终态只注入执行 id 和状态, 不复制完整结果', () => {
    const fixture = createFixture(true);
    fixture.queue.agentRunCompleted('session-a', 'agent-1', 'completed');
    fixture.queue.backgroundProcessCompleted('session-a', 'process-1', 'failed');

    const claim = fixture.queue.claimNextIteration('session-a', 'active-turn');

    expect(claim?.completionNoticeText).toContain('AgentRun agent-1 已结束, status=completed');
    expect(claim?.completionNoticeText).toContain('BackgroundProcess process-1 已结束, status=failed');
    expect(claim?.completionNoticeText).toContain('SubagentAwait');
    expect(claim?.completionNoticeText).toContain('ProcessOutput');
  });

  it('SubagentAwait 读到完整终态后撤掉尚未交付的 AgentRun 通知', () => {
    const fixture = createFixture(true);
    fixture.queue.agentRunCompleted('session-a', 'agent-1', 'completed');

    fixture.queue.agentRunResultRead('session-a', 'agent-1');

    expect(fixture.queue.claimNextIteration('session-a', 'active-turn')).toBeUndefined();
  });
});
