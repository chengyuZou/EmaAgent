// 验证 deriveLlmHistory 的投影规则（丢系统/未配对 Tool 块）与来源身份携带。
import { describe, expect, it } from 'vitest';
import type { Message as SessionMessage } from '@ema-agent/session';
import { deriveLlmHistory } from '../deriveLlmHistory.js';

const sessionId = 'session-1';
const turnId = 'turn-1';

function message(
  id: string,
  role: SessionMessage['role'],
  blocks: SessionMessage['blocks'],
  kind: SessionMessage['kind'] = 'normal',
): SessionMessage {
  return {
    id,
    sessionId,
    turnId,
    role,
    kind,
    blocks,
    interrupted: false,
    createdAt: 1,
  };
}

describe('deriveLlmHistory', () => {
  it('跳过旧系统消息、移除 thinking，产出携带来源 Session Message id', () => {
    const result = deriveLlmHistory([
      message('m1', 'system', '旧系统'),
      message('m2', 'assistant', [
        { type: 'thinking', thinking: '内部思考' },
        { type: 'text', text: '可见回答' },
      ]),
    ]);

    expect(result).toEqual([{
      sessionMessageId: 'm2',
      message: { role: 'assistant', content: [{ type: 'text', text: '可见回答' }] },
    }]);
  });

  it('被完全过滤的消息不占产出下标（身份不可按下标对齐输入）', () => {
    const result = deriveLlmHistory([
      message('m1', 'user', '   '),
      message('m2', 'user', '有效输入'),
    ]);

    expect(result).toEqual([{
      sessionMessageId: 'm2',
      message: { role: 'user', content: '有效输入' },
    }]);
  });

  it('只保留完整配对的 tool_use 和 tool_result', () => {
    const result = deriveLlmHistory([
      message('m1', 'assistant', [
        { type: 'tool_use', id: 'paired', name: 'Read', args: { path: 'a.ts' } },
        { type: 'tool_use', id: 'orphan', name: 'Read', args: { path: 'b.ts' } },
      ]),
      message('m2', 'user', [{
        type: 'tool_result',
        toolCallId: 'paired',
        content: 'file content',
      }]),
    ]);

    expect(result).toEqual([
      {
        sessionMessageId: 'm1',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'paired', name: 'Read', args: { path: 'a.ts' } }],
        },
      },
      {
        sessionMessageId: 'm2',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', toolCallId: 'paired', content: 'file content' }],
        },
      },
    ]);
  });

  it('拒绝结果先于调用或重复使用同一个 toolCallId 的伪配对', () => {
    const result = deriveLlmHistory([
      message('m1', 'user', [{
        type: 'tool_result',
        toolCallId: 'out-of-order',
        content: '提前出现的结果',
      }]),
      message('m2', 'assistant', [
        { type: 'tool_use', id: 'out-of-order', name: 'Read', args: {} },
        { type: 'tool_use', id: 'duplicate', name: 'Read', args: {} },
        { type: 'tool_use', id: 'duplicate', name: 'Read', args: {} },
        { type: 'text', text: '保留文本' },
      ]),
      message('m3', 'user', [{
        type: 'tool_result',
        toolCallId: 'duplicate',
        content: '歧义结果',
      }]),
    ]);

    expect(result).toEqual([{
      sessionMessageId: 'm2',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '保留文本' }],
      },
    }]);
  });
});
