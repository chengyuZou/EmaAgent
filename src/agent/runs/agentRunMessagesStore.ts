// 按块保存一次子 Agent 运行的内容（文本/思考/工具调用/结果），供按运行回放。
// 与根 Turn 同一模型：delta 按 (role, blockIndex) 累积并 upsert 同一行，
// tool_result 一次调用一行；运行状态机与终态统计归 agentRunStore.ts。

import type {
  AgentRunMessagesRepo,
} from '@ema-agent/storage';
import type { ToolResult } from '@ema-agent/tools';
import type { AgentLoopEvent } from '../events.js';
import type {
  AgentRunMessage,
  AgentRunTextContent,
  AgentRunToolCallContent,
} from './types.js';

/** 单次运行的流式缓冲：文本/思考按块累积全量，tool_call 累积 argsDelta。 */
interface RunBuffer {
  readonly textByBlock: Map<string, string>;
}

export class AgentRunMessagesStore {
  private readonly buffers = new Map<string, RunBuffer>();

  constructor(private readonly repo: AgentRunMessagesRepo) {}

  /**
   * 在 AgentLoop generator 恢复前同步落库：块内容随 delta upsert 同一行，
   * tool_result 落库即关账。进程中断时最后一个已 upsert 的块前缀仍在库中。
   */
  record(agentRunId: string, event: AgentLoopEvent): void {
    const createdAt = Date.now();
    switch (event.type) {
      case 'text_delta': {
        const text = this.accumulate(agentRunId, 'assistant', event.blockIndex, event.delta);
        this.repo.upsertBlock({
          agentRunId,
          role: 'assistant',
          blockIndex: event.blockIndex,
          content: { blockIndex: event.blockIndex, text } satisfies AgentRunTextContent,
          createdAt,
        });
        return;
      }
      case 'thinking_delta': {
        const text = this.accumulate(agentRunId, 'reasoning', event.blockIndex, event.delta);
        this.repo.upsertBlock({
          agentRunId,
          role: 'reasoning',
          blockIndex: event.blockIndex,
          content: { blockIndex: event.blockIndex, text } satisfies AgentRunTextContent,
          createdAt,
        });
        return;
      }
      case 'tool_use_partial': {
        const argsDelta = this.accumulate(agentRunId, 'tool_call', event.blockIndex, event.argsDelta);
        this.repo.upsertBlock({
          agentRunId,
          role: 'tool_call',
          blockIndex: event.blockIndex,
          content: {
            blockIndex: event.blockIndex,
            callId: event.toolCallId,
            name: event.toolName,
            argsDelta,
            partial: true,
          } satisfies AgentRunToolCallContent,
          createdAt,
        });
        return;
      }
      case 'tool_use_completed':
        // 与 partial 同一行：最终 args 整体覆盖累积的 argsDelta。
        this.repo.upsertBlock({
          agentRunId,
          role: 'tool_call',
          blockIndex: event.blockIndex,
          content: {
            blockIndex: event.blockIndex,
            callId: event.toolCallId,
            name: event.toolName,
            args: event.args,
          } satisfies AgentRunToolCallContent,
          createdAt,
        });
        return;
      case 'tool_result':
        this.repo.insert({
          agentRunId,
          role: 'tool_result',
          content: event.result,
          createdAt,
        });
        return;
      case 'loop_stopped':
        this.buffers.delete(agentRunId);
        return;
      default:
        return;
    }
  }

  /** 运行非正常终止（无 loop_stopped）时丢弃内存缓冲；已 upsert 的行不受影响。 */
  discard(agentRunId: string): void {
    this.buffers.delete(agentRunId);
  }

  /** role↔content 形状由本类 record 单点写入；读回按 role 还原同一联合。 */
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

  private accumulate(
    agentRunId: string,
    role: 'assistant' | 'reasoning' | 'tool_call',
    blockIndex: number,
    delta: string,
  ): string {
    let buffer = this.buffers.get(agentRunId);
    if (!buffer) {
      buffer = { textByBlock: new Map() };
      this.buffers.set(agentRunId, buffer);
    }
    const key = `${role}:${blockIndex}`;
    const next = (buffer.textByBlock.get(key) ?? '') + delta;
    buffer.textByBlock.set(key, next);
    return next;
  }
}
