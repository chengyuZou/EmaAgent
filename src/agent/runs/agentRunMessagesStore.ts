// 按序记录一次子 Agent 运行的内容消息（文本/思考/工具调用/结果），供按运行回放。
// 一次运行 N 行；运行状态机与终态统计归 agentRunStore.ts。

import type {
  AgentRunMessageInsert,
  AgentRunMessagesRepo,
} from '@ema-agent/storage';
import type { ToolResult } from '@ema-agent/tools';
import type { AgentLoopEvent } from '../events.js';
import type {
  AgentRunMessage,
  AgentRunTextContent,
  AgentRunToolCallContent,
} from './types.js';

export class AgentRunMessagesStore {
  constructor(private readonly repo: AgentRunMessagesRepo) {}

  /**
   * 在 AgentLoop generator 恢复前同步落库。这样 tool_use 与 tool_result 的
   * 持久化顺序会自然早于工具启动和结果关账，进程中断时也保留最后一个已见事实。
   */
  record(agentRunId: string, event: AgentLoopEvent): void {
    const message = messageFor(agentRunId, event);
    if (message) this.repo.insert(message);
  }

  /** role↔content 形状由本类 messageFor 单点写入；读回按 role 还原同一联合。 */
  listForRun(agentRunId: string): readonly AgentRunMessage[] {
    return this.repo.listForRun(agentRunId).map((row): AgentRunMessage => {
      const base = {
        id: row.id,
        agentRunId: row.agent_run_id,
        sequence: row.sequence,
        createdAt: row.created_at,
      };
      const content = JSON.parse(row.content_json) as unknown;
      switch (row.role) {
        case 'assistant':
        case 'reasoning':
          return { ...base, role: row.role, content: content as AgentRunTextContent };
        case 'tool_call':
          return { ...base, role: 'tool_call', content: content as AgentRunToolCallContent };
        case 'tool_result':
          return { ...base, role: 'tool_result', content: content as ToolResult };
      }
    });
  }
}

function messageFor(
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
