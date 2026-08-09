// 验证 Session 历史只投影可重放内容，并丢弃旧系统、Narrative 和未配对 Tool 块。
import { describe, expect, it } from 'vitest';
import { asMessageId, asSessionId, asTurnId } from '@ema-agent/ids';
import type { Message as SessionMessage } from '@ema-agent/session';
import { buildMessages } from '../buildMessages.js';

const sessionId = asSessionId('session-1');
const turnId = asTurnId('turn-1');

function message(
  id: string,
  role: SessionMessage['role'],
  blocks: SessionMessage['blocks'],
  kind: SessionMessage['kind'] = 'chat',
): SessionMessage {
  return {
    id: asMessageId(id),
    sessionId,
    turnId,
    role,
    kind,
    blocks,
    interrupted: false,
    createdAt: 1,
  };
}

describe('buildMessages', () => {
  it('跳过旧系统和 narrative_context，并移除 thinking', () => {
    const result = buildMessages([
      message('m1', 'system', '旧系统'),
      message('m2', 'user', { timelines: [{ name: 'A', charCount: 3, text: '剧情' }] }, 'narrative_context'),
      message('m3', 'assistant', [
        { type: 'thinking', thinking: '内部思考' },
        { type: 'text', text: '可见回答' },
      ]),
    ]);

    expect(result).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: '可见回答' }] },
    ]);
  });

  it('只保留完整配对的 tool_use 和 tool_result', () => {
    const result = buildMessages([
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
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'paired', name: 'Read', args: { path: 'a.ts' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'paired', content: 'file content' }],
      },
    ]);
  });

  it('拒绝结果先于调用或重复使用同一个 toolCallId 的伪配对', () => {
    const result = buildMessages([
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
      role: 'assistant',
      content: [{ type: 'text', text: '保留文本' }],
    }]);
  });
});
