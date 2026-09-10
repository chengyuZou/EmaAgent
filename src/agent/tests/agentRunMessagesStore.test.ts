// 验证子 Agent 转录按完整 Assistant 消息分轮保存, 不因 Provider 重用块序号而覆盖前一轮.

import type { AgentRunMessageRow, AgentRunMessagesRepo } from '@ema-agent/storage';
import { describe, expect, it, vi } from 'vitest';
import { AgentRunMessagesStore } from '../runs/agentRunMessagesStore.js';

describe('AgentRunMessagesStore', () => {
  it('连续两轮都保存为独立 Assistant 消息', () => {
    const rows: AgentRunMessageRow[] = [];
    const repo = {
      insert: vi.fn((message: {
        agentRunId: string;
        role: 'assistant' | 'tool_result';
        content: unknown;
        createdAt: number;
      }) => {
        rows.push({
          id: `message-${rows.length + 1}`,
          agent_run_id: message.agentRunId,
          role: message.role,
          content_json: JSON.stringify(message.content),
          sequence: rows.length + 1,
          created_at: message.createdAt,
        });
      }),
      listForRun: vi.fn(() => rows),
    } as unknown as AgentRunMessagesRepo;
    const store = new AgentRunMessagesStore(repo);

    store.record('run-1', {
      type: 'assistant_message_completed',
      iteration: 1,
      llmCallId: 'call-1',
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: '先读取文件.' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', args: { path: 'a.ts' } },
      ],
    });
    store.record('run-1', {
      type: 'assistant_message_completed',
      iteration: 2,
      llmCallId: 'call-2',
      stopReason: 'end_turn',
      content: [{ type: 'text', text: '读取完成.' }],
    });

    expect(store.listForRun('run-1')).toMatchObject([
      {
        role: 'assistant',
        sequence: 1,
        content: [
          { type: 'text', text: '先读取文件.' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', args: { path: 'a.ts' } },
        ],
      },
      { role: 'assistant', sequence: 2, content: [{ type: 'text', text: '读取完成.' }] },
    ]);

    expect(store.findToolInteraction('run-1', 'tool-1')).toEqual({
      name: 'Read',
      args: { path: 'a.ts' },
    });
    store.appendToolResult('run-1', {
      type: 'tool_result',
      toolCallId: 'tool-1',
      content: '文件内容',
    });
    expect(store.findToolInteraction('run-1', 'tool-1')).toMatchObject({
      result: { toolCallId: 'tool-1', content: '文件内容' },
    });
  });
});
