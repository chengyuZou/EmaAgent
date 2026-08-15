// 把子 AgentLoop 已发生的内容事实立即写入独立 transcript，并提供按运行查询。

import type {
  AgentRunMessageInsert,
  AgentRunMessagesRepo,
} from '@ema-agent/storage';
import type { AgentLoopEvent } from '../events.js';
import type { AgentRunTranscriptMessage } from './types.js';

export class AgentRunTranscript {
  constructor(private readonly repo: AgentRunMessagesRepo) {}

  /**
   * 在 AgentLoop generator 恢复前同步落库。这样 tool_use 与 tool_result 的
   * 持久化顺序会自然早于工具启动和结果关账，进程中断时也保留最后一个已见事实。
   */
  record(agentRunId: string, event: AgentLoopEvent): void {
    const message = transcriptMessageFor(agentRunId, event);
    if (message) this.repo.insert(message);
  }

  listForRun(agentRunId: string): readonly AgentRunTranscriptMessage[] {
    return this.repo.listForRun(agentRunId).map((row) => ({
      id: row.id,
      agentRunId: row.agent_run_id,
      role: row.role,
      content: JSON.parse(row.content_json) as unknown,
      sequence: row.sequence,
      createdAt: row.created_at,
    }));
  }

}

function transcriptMessageFor(
  agentRunId: string,
  event: AgentLoopEvent,
): AgentRunMessageInsert | undefined {
  const createdAt = Date.now();
  switch (event.type) {
    case 'text_delta':
      return {
        agentRunId,
        role: 'assistant',
        content: { blockIndex: event.blockIndex, text: event.delta },
        createdAt,
      };
    case 'thinking_delta':
      return {
        agentRunId,
        role: 'reasoning',
        content: { blockIndex: event.blockIndex, text: event.delta },
        createdAt,
      };
    case 'tool_use_completed':
      return {
        agentRunId,
        role: 'tool_call',
        content: {
          blockIndex: event.blockIndex,
          callId: event.toolCallId,
          name: event.toolName,
          args: event.args,
        },
        createdAt,
      };
    case 'tool_use_partial':
      return {
        agentRunId,
        role: 'tool_call',
        content: {
          blockIndex: event.blockIndex,
          callId: event.toolCallId,
          name: event.toolName,
          argsDelta: event.argsDelta,
          partial: true,
        },
        createdAt,
      };
    case 'tool_result':
      return {
        agentRunId,
        role: 'tool_result',
        content: event.result,
        createdAt,
      };
    default:
      return undefined;
  }
}
