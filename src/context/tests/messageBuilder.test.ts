// 测试 Session 历史只把跨 Provider 可安全重放的内容投影为模型消息。
import { describe, expect, it } from 'vitest';
import type { Message as SessionMessage } from '@ema-agent/session';
import { buildModelMessages } from '../messageBuilder.js';

function message(input: Partial<SessionMessage> & Pick<SessionMessage, 'role' | 'kind' | 'blocks'>): SessionMessage {
  return {
    id: 'message-1' as SessionMessage['id'],
    sessionId: 'session-1' as SessionMessage['sessionId'],
    turnId: null,
    interrupted: false,
    createdAt: 1,
    ...input,
  };
}

describe('buildModelMessages', () => {
  it('移除 thinking、tool_use、tool_result 与界面展示字段', () => {
    const result = buildModelMessages([
      message({
        role: 'assistant',
        kind: 'normal',
        blocks: [
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: 'visible' },
          { type: 'tool_use', id: 'call-1', name: 'read', args: {} },
        ],
      }),
      message({
        role: 'user',
        kind: 'tool_results',
        blocks: [{ type: 'tool_result', toolUseId: 'call-1', content: 'secret output' }],
      }),
    ]);

    expect(result).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'visible' }] },
    ]);
  });

  it('把 Narrative 多时间线投影为一条模型背景消息', () => {
    const result = buildModelMessages([
      message({
        role: 'user',
        kind: 'narrative_context',
        blocks: {
          timelines: [
            { name: '1st Loop', charCount: 5, text: 'first' },
            { name: '2nd Loop', charCount: 6, text: 'second' },
          ],
        },
      }),
    ]);

    expect(result).toEqual([{
      role: 'user',
      content: '[NARRATIVE CONTEXT - do not quote verbatim; use as background]\n\n'
        + '## 1st Loop\nfirst\n\n## 2nd Loop\nsecond',
    }]);
  });
});
