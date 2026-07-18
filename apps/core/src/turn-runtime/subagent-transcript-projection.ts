// 把 Subagent SSE 投影为持久 transcript，并隔离辅助落库故障。

import type { AgentTaskMessageInsert } from '@ema-agent/storage';
import type { EmaStreamEvent } from '@ema-agent/contracts';

export interface AgentTaskMessageWriter {
  insert(message: AgentTaskMessageInsert): void;
}

export interface TurnProjectionWarning {
  projection: 'subagent_transcript';
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * Transcript 是 Turn 事件的辅助查询投影，不是 SSE 主链的事实源。
 * 写入失败时保留待写队列供下一条事件重试，并返回 warning 给主链发布。
 */
export class SubagentTranscriptProjection {
  private readonly textBySubagent = new Map<string, string>();
  private readonly reasoningBySubagent = new Map<string, string>();
  private readonly pending: AgentTaskMessageInsert[] = [];
  private failureReported = false;

  constructor(private readonly writer: AgentTaskMessageWriter) {}

  apply(event: EmaStreamEvent): TurnProjectionWarning | undefined {
    this.collect(event);
    return this.flushPending();
  }

  private collect(event: EmaStreamEvent): void {
    if (event.type === 'subagent_stream') {
      const { subagentId, ev: inner } = event;
      if (inner.type === 'text_delta') {
        this.textBySubagent.set(
          subagentId,
          (this.textBySubagent.get(subagentId) ?? '') + inner.delta,
        );
        return;
      }
      if (inner.type === 'reasoning_delta') {
        this.reasoningBySubagent.set(
          subagentId,
          (this.reasoningBySubagent.get(subagentId) ?? '') + inner.delta,
        );
        return;
      }
      if (inner.type === 'iteration') {
        this.queueBufferedText(subagentId);
        return;
      }
      if (inner.type === 'tool_call') {
        this.queueBufferedText(subagentId);
        this.pending.push({
          taskId: subagentId,
          role: 'tool_call',
          content: {
            callId: inner.callId,
            name: inner.name,
            args: inner.args,
            iteration: inner.iteration,
          },
          createdAt: Date.now(),
        });
        return;
      }
      if (inner.type === 'tool_result') {
        this.pending.push({
          taskId: subagentId,
          role: 'tool_result',
          content: {
            callId: inner.callId,
            name: inner.name,
            excerpt: inner.excerpt,
            isError: inner.isError,
            error: inner.error,
            durationMs: inner.durationMs,
          },
          createdAt: Date.now(),
        });
      }
      return;
    }

    if (
      event.type === 'subagent_completed' ||
      event.type === 'subagent_failed' ||
      event.type === 'subagent_aborted'
    ) {
      this.queueBufferedText(event.subagentId);
      this.textBySubagent.delete(event.subagentId);
      this.reasoningBySubagent.delete(event.subagentId);
    }
  }

  private queueBufferedText(subagentId: string): void {
    const reasoning = this.reasoningBySubagent.get(subagentId);
    if (reasoning) {
      this.pending.push({
        taskId: subagentId,
        role: 'reasoning',
        content: { text: reasoning },
        createdAt: Date.now(),
      });
      this.reasoningBySubagent.delete(subagentId);
    }

    const text = this.textBySubagent.get(subagentId);
    if (text) {
      this.pending.push({
        taskId: subagentId,
        role: 'assistant',
        content: { text },
        createdAt: Date.now(),
      });
      this.textBySubagent.delete(subagentId);
    }
  }

  private flushPending(): TurnProjectionWarning | undefined {
    while (this.pending.length > 0) {
      const message = this.pending[0]!;
      try {
        this.writer.insert(message);
        this.pending.shift();
        this.failureReported = false;
      } catch (error) {
        if (this.failureReported) return undefined;
        this.failureReported = true;
        return {
          projection: 'subagent_transcript',
          code: 'storage/agent_task_message_projection_failed',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        };
      }
    }
    return undefined;
  }
}
