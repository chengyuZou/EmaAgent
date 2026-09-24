// 子 Agent 在完整 tool_use 时先保存调用事实, 消息闭合后补全同一行; delta 只供实时界面消费.

import { randomUUID } from 'node:crypto';
import type { AssistantBlock, UserBlock } from '@ema-agent/llm';
import type { SubagentMessagesRepo } from '@ema-agent/storage';
import type { ToolResult } from '@ema-agent/tools';
import type { AgentLoopEvent } from '../events.js';
import type { SubagentMessage, SubagentToolInteraction } from './types.js';

type ToolUseBlock = Extract<AssistantBlock, { type: 'tool_use' }>;

interface ActiveAssistant {
  readonly id: string;
  readonly toolUses: Map<number, ToolUseBlock>;
}

export class SubagentMessagesStore {
  private readonly activeAssistants = new Map<string, ActiveAssistant>();

  constructor(private readonly repo: SubagentMessagesRepo) {}

  record(subagentId: string, event: AgentLoopEvent): void {
    if (event.type === 'tool_use_completed') {
      const block: ToolUseBlock = {
        type: 'tool_use',
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
      };
      let active = this.activeAssistants.get(subagentId);
      if (!active) {
        active = { id: randomUUID(), toolUses: new Map() };
        this.activeAssistants.set(subagentId, active);
      }
      active.toolUses.set(event.blockIndex, block);
      const blocksJson = JSON.stringify(
        [...active.toolUses.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, toolUse]) => toolUse),
      );
      if (active.toolUses.size === 1) {
        // 第一个完整 tool_use 必须先落库, AgentLoop 恢复后才启动副作用.
        this.repo.insert({
          id: active.id,
          subagentId,
          role: 'assistant',
          blocksJson,
          createdAt: Date.now(),
        });
      } else {
        this.repo.updateBlocks(active.id, blocksJson);
      }
      return;
    }

    if (event.type === 'assistant_message_completed') {
      const active = this.activeAssistants.get(subagentId);
      if (active) {
        this.repo.updateBlocks(active.id, JSON.stringify(event.content));
        this.activeAssistants.delete(subagentId);
      } else {
        this.repo.insert({
          id: randomUUID(),
          subagentId,
          role: 'assistant',
          blocksJson: JSON.stringify(event.content),
          createdAt: Date.now(),
        });
      }
      return;
    }

    if (event.type === 'tool_result') {
      this.appendToolResult(subagentId, event.result);
      return;
    }

    if (event.type === 'loop_stopped') this.interruptActiveAssistant(subagentId);
  }

  /** 模型流中断时保留已执行工具的调用事实, 标记尚未闭合的 Assistant. */
  interruptActiveAssistant(subagentId: string): void {
    const active = this.activeAssistants.get(subagentId);
    if (!active) return;
    this.repo.markInterrupted(active.id);
    this.activeAssistants.delete(subagentId);
  }

  appendToolResult(subagentId: string, result: ToolResult): void {
    this.repo.insert({
      id: randomUUID(),
      subagentId,
      role: 'user',
      kind: 'tool_results',
      blocksJson: JSON.stringify([result]),
      createdAt: Date.now(),
    });
  }

  listPage(
    subagentId: string,
    beforeSequence: number | undefined,
    limit: number,
  ): { items: readonly SubagentMessage[]; nextCursor: number | null } {
    const page = this.repo.listPage(subagentId, beforeSequence, limit);
    return {
      items: page.rows.map(toMessage),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * 子 Agent 的工具调用不进入根 Session History. 启动恢复按执行行上的
   * subagentId 走这里, 才能找到崩溃前已经持久化的 tool_use/tool_result 配对.
   */
  findToolInteraction(subagentId: string, toolCallId: string): SubagentToolInteraction | undefined {
    let interaction: SubagentToolInteraction | undefined;
    for (const message of this.repo.listAllForSubagent(subagentId).map(toMessage)) {
      if (message.role === 'assistant') {
        const call = message.blocks.find(block => (
          block.type === 'tool_use' && block.id === toolCallId
        ));
        if (call?.type === 'tool_use') interaction = { name: call.name, args: call.args };
        continue;
      }
      if (interaction && message.kind === 'tool_results' && typeof message.blocks !== 'string') {
        const result = message.blocks.find(block => (
          block.type === 'tool_result' && block.toolCallId === toolCallId
        ));
        if (result?.type === 'tool_result') interaction.result = result as ToolResult;
      }
    }
    return interaction;
  }
}

function toMessage(row: ReturnType<SubagentMessagesRepo['listAllForSubagent']>[number]): SubagentMessage {
  const base = {
    id: row.id,
    subagentId: row.subagent_id,
    kind: row.kind,
    interrupted: row.interrupted === 1,
    sequence: row.sequence,
    createdAt: row.created_at,
  };
  const blocks = JSON.parse(row.blocks_json) as unknown;
  if (row.role === 'assistant') {
    return { ...base, role: 'assistant', blocks: blocks as readonly AssistantBlock[] };
  }
  return { ...base, role: 'user', blocks: blocks as string | readonly (UserBlock | ToolResult)[] };
}
