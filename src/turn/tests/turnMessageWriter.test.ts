// 测试流式落库：首个 delta 建消息、tool_use 先落库、孤儿 tool_use 终态合成。
import { describe, expect, it } from 'vitest';
import type { AgentLoopEvent } from '@ema-agent/agent';
import type {
  AppendMessageInput,
  MessageBlocks,
  SessionStore,
} from '@ema-agent/session';
import { TurnMessageWriter } from '../loop/turnMessageWriter.js';

interface RecordedAppend extends AppendMessageInput {
  id: string;
}

function fakeSessions() {
  const appends: RecordedAppend[] = [];
  const updates: Array<{ id: string; blocks: MessageBlocks }> = [];
  const interrupted: string[] = [];
  let nextId = 1;
  const sessions = {
    appendMessage: (input: AppendMessageInput) => {
      const record = { ...input, id: `m${nextId++}` };
      appends.push(record);
      return record;
    },
    updateMessageBlocks: (id: string, blocks: MessageBlocks) => {
      updates.push({ id, blocks });
    },
    markMessageInterrupted: (id: string) => {
      interrupted.push(id);
    },
  } as unknown as Pick<SessionStore, 'appendMessage' | 'updateMessageBlocks' | 'markMessageInterrupted'>;
  return { sessions, appends, updates, interrupted };
}

function makeWriter(fake: ReturnType<typeof fakeSessions>) {
  return new TurnMessageWriter('s1', 't1', fake.sessions);
}

describe('TurnMessageWriter', () => {
  it('首个 delta 创建 assistant 消息，后续 delta 续写同一消息', async () => {
    const fake = fakeSessions();
    const writer = makeWriter(fake);
    await writer.apply({ type: 'text_delta', blockIndex: 0, delta: '你' });
    await writer.apply({ type: 'text_delta', blockIndex: 0, delta: '好' });

    expect(fake.appends).toHaveLength(1);
    expect(fake.appends[0]).toMatchObject({ role: 'assistant', sessionId: 's1', turnId: 't1' });
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]!.blocks).toEqual([{ type: 'text', text: '你好' }]);
  });

  it('tool_use_completed 落库并登记孤儿；tool_result 落库后解除', async () => {
    const fake = fakeSessions();
    const writer = makeWriter(fake);
    await writer.apply({ type: 'text_delta', blockIndex: 0, delta: '我来查' });
    await writer.apply({
      type: 'tool_use_completed',
      blockIndex: 1,
      toolCallId: 'c1',
      toolName: 'Read',
      args: { path: '/a' },
    });
    await writer.apply({
      type: 'tool_result',
      result: { type: 'tool_result', toolCallId: 'c1', content: '文件内容', isError: false },
    } as AgentLoopEvent);

    const toolResults = fake.appends.filter(a => a.kind === 'tool_results');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.blocks).toEqual([
      { type: 'tool_result', toolCallId: 'c1', content: '文件内容', isError: false },
    ]);

    await writer.finish('completed');
    // completed 且无孤儿：不再补 interrupted，也不合成取消结果。
    expect(fake.interrupted).toHaveLength(0);
    expect(fake.appends.filter(a => a.kind === 'tool_results')).toHaveLength(1);
  });

  it('aborted 终态：assistant 标 interrupted，孤儿 tool_use 合成取消结果', async () => {
    const fake = fakeSessions();
    const writer = makeWriter(fake);
    await writer.apply({ type: 'text_delta', blockIndex: 0, delta: '我来改' });
    await writer.apply({
      type: 'tool_use_completed',
      blockIndex: 1,
      toolCallId: 'c1',
      toolName: 'Edit',
      args: {},
    });

    await writer.finish('aborted');

    expect(fake.interrupted).toEqual(['m1']);
    const synthesized = fake.appends.filter(a => a.kind === 'tool_results');
    expect(synthesized).toHaveLength(1);
    expect(synthesized[0]!.blocks).toEqual([
      {
        type: 'tool_result',
        toolCallId: 'c1',
        content: '[Turn 中断，工具调用未产生结果]',
        isError: true,
        errorCode: 'tool/cancelled',
      },
    ]);
  });

  it('iteration_started 重置本轮累积，新迭代另起消息', async () => {
    const fake = fakeSessions();
    const writer = makeWriter(fake);
    await writer.apply({ type: 'text_delta', blockIndex: 0, delta: '第一段' });
    await writer.apply({ type: 'iteration_started', iteration: 2, continuesOutput: false, state: {} as never });
    await writer.apply({ type: 'text_delta', blockIndex: 0, delta: '第二段' });

    expect(fake.appends.filter(a => a.role === 'assistant')).toHaveLength(2);
  });
});
