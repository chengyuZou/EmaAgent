// 这里测试刷新 Session 后，数据库里的真实文件 diff 仍会还原到对应的工具调用块。
import { describe, expect, it } from 'vitest';
import type { MessageWire } from '@ema-agent/session';
import { assembleHistory } from '../src/stores/conversation-history.js';

describe('tool presentation history', () => {
  it('按 toolCallId 把持久化 presentation 合并回 Edit 调用', () => {
    const assistant: MessageWire = {
      id: 'message-assistant',
      sessionId: 'session-test',
      turnId: 'turn-test',
      role: 'assistant',
      kind: 'normal',
      blocks: [{
        type: 'tool_use',
        id: 'call-edit',
        name: 'Edit',
        args: { file_path: 'demo.txt', old_string: 'old', new_string: 'new' },
      }],
      interrupted: false,
      createdAt: 1,
    };
    const toolResults: MessageWire = {
      id: 'message-result',
      sessionId: 'session-test',
      turnId: 'turn-test',
      role: 'user',
      kind: 'tool_results',
      blocks: [{
        type: 'tool_result',
        toolCallId: 'call-edit',
        content: '{"filePath":"demo.txt","replacements":1}',
        presentation: {
          kind: 'file_change',
          operation: 'update',
          filePath: 'demo.txt',
          unifiedDiff: '--- a/demo.txt\n+++ b/demo.txt\n-old\n+new\n',
          additions: 1,
          deletions: 1,
          truncated: false,
        },
      }],
      interrupted: false,
      createdAt: 2,
    };

    const history = assembleHistory([toolResults, assistant], []);
    const slice = history[0]?.slices?.[0];

    expect(slice).toEqual(expect.objectContaining({
      type: 'tool_use',
      callId: 'call-edit',
      presentation: expect.objectContaining({ kind: 'file_change', additions: 1, deletions: 1 }),
    }));
  });
});
