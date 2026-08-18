// 测试流式调度器的并发屏障、模型顺序 FIFO、交付/关账握手与取消。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolPermissionContext } from '@ema-agent/permission';
import {
  buildTool,
  contextOk,
  ToolPool,
  type Tool,
  type ToolExecutionEvent,
} from '../index.js';
import {
  StreamingToolExecutor,
  type StreamingToolExecutorEvent,
} from '../execution/streamingToolExecutor.js';

const SESSION_ID = '00000000-0000-4000-8000-0000000000a1';
const TURN_ID = '00000000-0000-4000-8000-0000000000b1';

const PERMISSION_CONTEXT: ToolPermissionContext = {
  mode: 'default',
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: false,
};

type AnyTestTool = Tool<{ value: number }, unknown, Record<string, never>, never>;

/** 执行体被门闩控制的假工具;started 在 execute 被调用时兑现。 */
function gatedTool(name: string, concurrencySafe: boolean): {
  tool: AnyTestTool;
  release: () => void;
  started: Promise<void>;
} {
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const tool = buildTool({
    name,
    description: name,
    inputSchema: z.object({ value: z.number() }),
    validateContext: () => contextOk({}),
    isReadOnly: () => concurrencySafe,
    isConcurrencySafe: () => concurrencySafe,
    checkPermissions: async () => ({ behavior: 'allow' as const }),
    execute: async (_input, _context, invocation) => {
      markStarted();
      await gate;
      // 模仿真实 Tool:被中止时以拒绝收场,而不是无视信号照常完成。
      if (invocation.signal.aborted) throw invocation.signal.reason;
      return { name };
    },
  }) as AnyTestTool;
  return { tool, release, started };
}

function makeExecutor(tools: AnyTestTool[]): {
  executor: StreamingToolExecutor;
  events: ToolExecutionEvent[];
} {
  const events: ToolExecutionEvent[] = [];
  const executor = new StreamingToolExecutor({
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    abortSignal: new AbortController().signal,
    toolPool: new ToolPool(tools as never),
    permissionContext: PERMISSION_CONTEXT,
    toolContext: { workspaceRoot: '', platform: process.platform },
    pushEv: event => events.push(event),
    wake: () => undefined,
  });
  return { executor, events };
}

function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function terminalNames(events: StreamingToolExecutorEvent[]): string[] {
  return events
    .filter((event): event is Extract<StreamingToolExecutorEvent, { type: 'tool_result' }> =>
      event.type === 'tool_result')
    .map(event => event.name);
}

describe('StreamingToolExecutor', () => {
  it('并发安全调用一起开跑,互不等待', async () => {
    const first = gatedTool('A', true);
    const second = gatedTool('B', true);
    const { executor } = makeExecutor([first.tool, second.tool]);

    executor.addTool(0, 'c1', 'A', { value: 1 });
    executor.addTool(1, 'c2', 'B', { value: 2 });
    executor.start();

    await Promise.all([first.started, second.started]);
    first.release();
    second.release();
    await executor.join();

    expect(executor.allDone()).toBe(true);
  });

  it('非并发安全调用必须等前面的全部结束才独占开跑', async () => {
    const safe = gatedTool('Safe', true);
    const unsafe = gatedTool('Unsafe', false);
    const { executor } = makeExecutor([safe.tool, unsafe.tool]);

    executor.addTool(0, 'c1', 'Safe', { value: 1 });
    executor.addTool(1, 'c2', 'Unsafe', { value: 2 });
    executor.start();
    await safe.started;

    const unsafeStartedEarly = await Promise.race([
      unsafe.started.then(() => true),
      tick().then(() => false),
    ]);
    expect(unsafeStartedEarly).toBe(false);

    safe.release();
    await unsafe.started;
    unsafe.release();
    await executor.join();
    expect(executor.allDone()).toBe(true);
  });

  it('终态按模型 blockIndex FIFO 发射,即使后面的先完成', async () => {
    const slow = gatedTool('Slow', true);
    const fast = gatedTool('Fast', true);
    const { executor, events } = makeExecutor([slow.tool, fast.tool]);

    executor.addTool(0, 'c1', 'Slow', { value: 1 });
    executor.addTool(1, 'c2', 'Fast', { value: 2 });
    executor.start();
    await Promise.all([slow.started, fast.started]);

    fast.release();
    await tick();
    expect(terminalNames(events)).toEqual([]);

    slow.release();
    await executor.join();
    expect(terminalNames(events)).toEqual(['Slow', 'Fast']);
  });

  it('takeCompletedResults 只交队首连续完成;acknowledgeResult 关账', async () => {
    const first = gatedTool('A', true);
    const second = gatedTool('B', true);
    const { executor } = makeExecutor([first.tool, second.tool]);

    executor.addTool(0, 'c1', 'A', { value: 1 });
    executor.addTool(1, 'c2', 'B', { value: 2 });
    executor.start();
    await Promise.all([first.started, second.started]);

    second.release();
    await tick();
    expect(executor.takeCompletedResults()).toHaveLength(0);

    first.release();
    await tick();
    const delivered = executor.takeCompletedResults();
    expect(delivered.map(result => result.toolCallId)).toEqual(['c1', 'c2']);
    expect(() => executor.acknowledgeResult('c1')).not.toThrow();
    // 重复关账由状态机幂等吸收;未交付的关账才报错。
    expect(() => executor.acknowledgeResult('c1')).not.toThrow();
    expect(() => executor.acknowledgeResult('c-unknown')).toThrow('tool_result_not_delivered');
  });

  it('abortTool 只取消指定调用,兄弟照常完成', async () => {
    const victim = gatedTool('Victim', true);
    const sibling = gatedTool('Sibling', true);
    const { executor } = makeExecutor([victim.tool, sibling.tool]);

    executor.addTool(0, 'c1', 'Victim', { value: 1 });
    executor.addTool(1, 'c2', 'Sibling', { value: 2 });
    executor.start();
    await Promise.all([victim.started, sibling.started]);

    expect(executor.abortTool('c1')).toBe(true);
    // 模拟进程随取消死亡:门闩放行后,执行体按中止拒绝。
    victim.release();
    sibling.release();
    await executor.join();

    const results = executor.takeCompletedResults();
    expect(results[0]).toMatchObject({ toolCallId: 'c1', isError: true, errorCode: 'tool/cancelled' });
    expect(results[1]).toMatchObject({ toolCallId: 'c2', isError: false });
  });

  it('shutdown 后不再接受新调用,排队调用被取消', async () => {
    const gated = gatedTool('A', true);
    const { executor } = makeExecutor([gated.tool]);

    executor.addTool(0, 'c1', 'A', { value: 1 });
    executor.start();
    await gated.started;
    const shutdown = executor.shutdown('turn_abort', 500);
    executor.addTool(1, 'c2', 'A', { value: 2 });
    gated.release();

    await shutdown;
    expect(executor.allDone()).toBe(true);
    // shutdown 后登记的调用被拒绝,终态只有 c1 一个。
    expect(executor.takeCompletedResults().map(r => r.toolCallId)).toEqual(['c1']);
  });
});
