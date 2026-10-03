// 子代理消息与普通 Message 共用正文; fork 初始化、Run 写入和历史恢复在这里收口.
import { randomUUID } from 'node:crypto';
import { createAssistantThinkingBlock } from '@ema-agent/llm';
import type { AssistantBlock, LlmGenerationSource, LlmThinkingState } from '@ema-agent/llm';
import { parseMessageBlocksJson } from '@ema-agent/session';
import type { MessageBlocks } from '@ema-agent/session';
import type { MessagePageCursor, SubagentMessageInsert, SubagentMessageRow, SubagentMessagesRepo } from '@ema-agent/storage';
import type { ToolResult } from '@ema-agent/tools';
import type { AgentLoopEvent } from '../events.js';
import type { ForkParentMessages, SubagentMessage, SubagentToolInteraction } from './types.js';

type ToolUseBlock = Extract<AssistantBlock, { type: 'tool_use' }>;

interface ActiveAssistant {
  readonly id: string;
  stored: boolean;
  readonly text: Map<number, string>;
  readonly thinking: Map<number, string>;
  readonly thinkingStates: Map<number, LlmThinkingState>;
  readonly toolUses: Map<number, ToolUseBlock>;
}

const SUBAGENT_REMINDER =
  '你是子 Agent, 只完成本次委派任务并向父 Agent 交付结果. 父历史中的调用属于父 Agent, 不要重新执行. '
  + '父会话的 Goal 不属于你的任务, 不要持续推进父 Goal. '
  + '若命令转为尚未完成的后台任务, 交付 backgroundProcessId、任务用途和最后已知状态, '
  + '供父 Agent 使用 ProcessOutput 接手. 不要用操作系统 PID 替代 backgroundProcessId, 不要把已启动说成已完成.';

export class SubagentMessagesStore {
  private readonly activeAssistants = new Map<string, ActiveAssistant>();
  private lastTs = 0;

  constructor(private readonly repo: SubagentMessagesRepo) {}

  /** 新建 fork 才复制父前缀; 继续旧子代理只追加本次任务, 不再次 fork. */
  initialize(subagentId: string, runId: string, prompt: string, parent?: ForkParentMessages): void {
    const latest = this.repo.listPage(subagentId, undefined, 1).rows[0];
    this.lastTs = Math.max(this.lastTs, latest?.created_at ?? 0);
    const inserts: SubagentMessageInsert[] = [];
    if (parent) {
      const ids = new Map(parent.messages.map(message => [message.id, randomUUID()]));
      for (const message of parent.messages) {
        const through = message.summarizedThroughMessageId;
        inserts.push({
          id: ids.get(message.id)!, subagentId, runId: null,
          role: message.role, kind: message.kind,
          blocksJson: JSON.stringify(message.blocks), interrupted: message.interrupted,
          createdAt: this.nextTs(),
          // 只复制有效前缀. 摘要覆盖的旧消息不在副本里时, 以摘要自身位置为边界.
          summarizedThroughMessageId: through ? ids.get(through) : undefined,
          savedTokens: message.savedTokens,
          ...(message.role === 'assistant' && message.generatedBy
            ? {
                providerId: message.generatedBy.providerId,
                modelId: message.generatedBy.modelId,
                protocol: message.generatedBy.protocol,
              }
            : {}),
        });
      }
      const assistant = parent.messages.at(-1);
      const placeholders: ToolResult[] = [];
      if (assistant?.role === 'assistant' && Array.isArray(assistant.blocks)) {
        for (const block of assistant.blocks) {
          if (block.type !== 'tool_use') continue;
          placeholders.push({
            type: 'tool_result', toolCallId: block.id,
            content: 'This call belongs to the parent agent. Its result is not available in this fork.',
          });
        }
      }
      if (placeholders.length > 0) {
        inserts.push(this.messageInsert(subagentId, null, 'user', 'tool_results', placeholders));
      }
    }
    inserts.push(this.messageInsert(subagentId, runId, 'user', 'reminder', SUBAGENT_REMINDER));
    // description 是身份说明, 不是任务正文. 本次 prompt 原文单独保存为 User Message.
    inserts.push(this.messageInsert(subagentId, runId, 'user', 'normal', prompt));
    this.repo.insertMany(inserts);
  }

  record(subagentId: string, runId: string, event: AgentLoopEvent): string | undefined {
    if (event.type === 'text_delta' || event.type === 'thinking_delta'
      || event.type === 'thinking_completed' || event.type === 'tool_use_completed') {
      let active = this.activeAssistants.get(runId);
      if (!active) {
        active = {
          id: randomUUID(), stored: false, text: new Map(), thinking: new Map(),
          thinkingStates: new Map(), toolUses: new Map(),
        };
        this.activeAssistants.set(runId, active);
      }
      if (event.type === 'text_delta') {
        active.text.set(event.blockIndex, (active.text.get(event.blockIndex) ?? '') + event.delta);
      } else if (event.type === 'thinking_delta') {
        active.thinking.set(event.blockIndex, (active.thinking.get(event.blockIndex) ?? '') + event.delta);
      } else if (event.type === 'thinking_completed') {
        if (event.state) active.thinkingStates.set(event.blockIndex, event.state);
      } else {
        active.toolUses.set(event.blockIndex, {
          type: 'tool_use', id: event.toolCallId, name: event.toolName, args: event.args,
        });
      }
      this.persistAssistant(subagentId, runId, active, currentBlocks(active));
      return;
    }
    if (event.type === 'assistant_message_completed') {
      const active = this.activeAssistants.get(runId);
      if (active) {
        this.persistAssistant(subagentId, runId, active, [...event.content]);
        this.activeAssistants.delete(runId);
        return active.stored ? active.id : undefined;
      }
      if (event.content.length === 0) return;
      return this.append(subagentId, runId, 'assistant', 'normal', [...event.content]).id;
    }
    if (event.type === 'tool_result') return this.appendToolResult(subagentId, runId, event.result);
    if (event.type === 'loop_stopped') this.interruptActiveAssistant(runId);
    return;
  }

  interruptActiveAssistant(runId: string): void {
    const active = this.activeAssistants.get(runId);
    if (!active) return;
    if (active.stored) this.repo.markInterrupted(active.id);
    this.activeAssistants.delete(runId);
  }

  appendToolResult(subagentId: string, runId: string, result: ToolResult): string {
    return this.append(subagentId, runId, 'user', 'tool_results', [result]).id;
  }

  appendSummary(
    subagentId: string, runId: string, summary: string,
    summarizedThroughMessageId: string, savedTokens: number,
  ): SubagentMessage {
    const insert = this.messageInsert(subagentId, runId, 'user', 'summary', summary);
    insert.summarizedThroughMessageId = summarizedThroughMessageId;
    insert.savedTokens = savedTokens;
    this.repo.insert(insert);
    return {
      id: insert.id, subagentId, runId, role: 'user', kind: 'summary', blocks: summary,
      interrupted: false, createdAt: insert.createdAt, summarizedThroughMessageId, savedTokens,
    };
  }

  loadHistory(subagentId: string): SubagentMessage[] {
    return this.repo.listForSubagentFromSummary(subagentId).map(toMessage);
  }

  listPage(subagentId: string, cursor: MessagePageCursor | undefined, limit: number) {
    const page = this.repo.listPage(subagentId, cursor, limit);
    return { items: page.rows.map(toMessage), nextCursor: page.nextCursor };
  }

  findToolInteraction(subagentId: string, toolCallId: string): SubagentToolInteraction | undefined {
    let interaction: SubagentToolInteraction | undefined;
    for (const message of this.repo.listAllForSubagent(subagentId).map(toMessage)) {
      if (!message.runId || !Array.isArray(message.blocks)) continue;
      if (message.role === 'assistant') {
        const call = message.blocks.find(block => block.type === 'tool_use' && block.id === toolCallId);
        if (call?.type === 'tool_use') {
          interaction = { runId: message.runId, name: call.name, args: call.args };
        }
      } else if (interaction && message.runId === interaction.runId && message.kind === 'tool_results') {
        const result = message.blocks.find(block => block.type === 'tool_result' && block.toolCallId === toolCallId);
        if (result?.type === 'tool_result') interaction.result = result;
      }
    }
    return interaction;
  }

  private persistAssistant(
    subagentId: string, runId: string, active: ActiveAssistant, blocks: AssistantBlock[],
  ): void {
    if (blocks.length === 0) return;
    if (active.stored) {
      this.repo.updateBlocks(active.id, JSON.stringify(blocks));
    } else {
      const insert = this.messageInsert(subagentId, runId, 'assistant', 'normal', blocks);
      insert.id = active.id;
      this.repo.insert(insert);
      active.stored = true;
    }
  }

  private append(
    subagentId: string, runId: string, role: SubagentMessage['role'],
    kind: SubagentMessage['kind'], blocks: MessageBlocks,
  ): SubagentMessage {
    const insert = this.messageInsert(subagentId, runId, role, kind, blocks);
    this.repo.insert(insert);
    return {
      id: insert.id, subagentId, runId, role, kind, blocks,
      interrupted: false, createdAt: insert.createdAt, summarizedThroughMessageId: null,
    };
  }

  private messageInsert(
    subagentId: string, runId: string | null, role: SubagentMessage['role'],
    kind: SubagentMessage['kind'], blocks: MessageBlocks,
  ): SubagentMessageInsert {
    return {
      id: randomUUID(), subagentId, runId, role, kind,
      blocksJson: JSON.stringify(blocks), createdAt: this.nextTs(),
    };
  }

  private nextTs(): number {
    this.lastTs = Math.max(Date.now(), this.lastTs + 1);
    return this.lastTs;
  }
}

function toMessage(row: SubagentMessageRow): SubagentMessage {
  let generatedBy: LlmGenerationSource | undefined;
  if (row.role === 'assistant' && row.provider_id && row.model_id && row.protocol) {
    generatedBy = {
      providerId: row.provider_id, modelId: row.model_id,
      protocol: row.protocol as LlmGenerationSource['protocol'],
    };
  }
  return {
    id: row.id, subagentId: row.subagent_id, runId: row.run_id, role: row.role,
    kind: row.kind, blocks: parseMessageBlocksJson(row.blocks_json, row.role),
    interrupted: row.interrupted === 1, createdAt: row.created_at,
    summarizedThroughMessageId: row.summarized_through_message_id,
    ...(row.summary_saved_tokens !== null ? { savedTokens: row.summary_saved_tokens } : {}),
    ...(generatedBy ? { generatedBy } : {}),
  };
}

function currentBlocks(active: ActiveAssistant): AssistantBlock[] {
  const blocks = new Map<number, AssistantBlock>();
  for (const [index, text] of active.text) {
    if (text.trim()) blocks.set(index, { type: 'text', text });
  }
  for (const index of new Set([...active.thinking.keys(), ...active.thinkingStates.keys()])) {
    const block = createAssistantThinkingBlock(active.thinking.get(index), active.thinkingStates.get(index));
    if (block) blocks.set(index, block);
  }
  for (const [index, toolUse] of active.toolUses) blocks.set(index, toolUse);
  return [...blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => block);
}
