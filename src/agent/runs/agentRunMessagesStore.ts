// 子 Agent 转录只在完整模型消息与工具结果闭合时落库, 流式 delta 仅供实时界面消费.

import type { AssistantBlock } from '@ema-agent/llm';
import type { AgentRunMessagesRepo } from '@ema-agent/storage';
import type { ToolResult } from '@ema-agent/tools';
import type { AgentLoopEvent } from '../events.js';
import type { AgentRunMessage, AgentRunToolInteraction } from './types.js';

export class AgentRunMessagesStore {
  constructor(private readonly repo: AgentRunMessagesRepo) {}

  /**
   * AgentLoop 会在恢复 assistant_message_completed 的 generator 后才启动工具.
   * 因此这里同步写入完整 Assistant 消息, 同时保住"工具副作用前已有调用事实"的顺序.
   */
  record(agentRunId: string, event: AgentLoopEvent): void {
    if (event.type === 'assistant_message_completed') {
      this.repo.insert({
        agentRunId,
        role: 'assistant',
        content: event.content,
        createdAt: Date.now(),
      });
      return;
    }

    if (event.type === 'tool_result') {
      this.appendToolResult(agentRunId, event.result);
    }
  }

  appendToolResult(agentRunId: string, result: ToolResult): void {
    this.repo.insert({
      agentRunId,
      role: 'tool_result',
      content: result,
      createdAt: Date.now(),
    });
  }

  /** role 与 content 的形状由 record 单点写入, 读取时还原为可判别联合. */
  listForRun(agentRunId: string): readonly AgentRunMessage[] {
    return this.repo.listForRun(agentRunId).map((row): AgentRunMessage => {
      const base = {
        id: row.id,
        agentRunId: row.agent_run_id,
        sequence: row.sequence,
        createdAt: row.created_at,
      };
      const content = JSON.parse(row.content_json) as unknown;
      if (row.role === 'assistant') {
        return { ...base, role: 'assistant', content: content as readonly AssistantBlock[] };
      }
      return { ...base, role: 'tool_result', content: content as ToolResult };
    });
  }

  /**
   * 子 Agent 的工具调用不进入根 Session History. 启动恢复按执行行上的
   * agentRunId 走这里, 才能找到崩溃前已经持久化的 tool_use/tool_result 配对.
   */
  findToolInteraction(agentRunId: string, toolCallId: string): AgentRunToolInteraction | undefined {
    let interaction: AgentRunToolInteraction | undefined;
    for (const message of this.listForRun(agentRunId)) {
      if (message.role === 'assistant') {
        const call = message.content.find(block => (
          block.type === 'tool_use' && block.id === toolCallId
        ));
        if (call?.type === 'tool_use') interaction = { name: call.name, args: call.args };
        continue;
      }
      if (interaction && message.content.toolCallId === toolCallId) {
        interaction.result = message.content;
      }
    }
    return interaction;
  }
}
