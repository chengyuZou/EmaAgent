// 测试 Subagent transcript 辅助投影失败隔离、缓冲与后续重试。

import { describe, expect, it } from 'vitest';
import type { AgentRunMessageInsert } from '@ema-agent/storage';
import type { EmaStreamEvent } from '@ema-agent/turn';
import { SubagentTranscriptProjection } from '../src/turn-runtime/subagent-transcript-projection.js';

describe('SubagentTranscriptProjection', () => {
  it('落库失败返回结构化 warning，下一条事件继续重试且不丢正文', () => {
    const written: AgentRunMessageInsert[] = [];
    let failNext = true;
    const projection = new SubagentTranscriptProjection({
      insert(message) {
        if (failNext) {
          failNext = false;
          throw new Error('database is busy');
        }
        written.push(message);
      },
    });

    expect(projection.apply(subagentText('hello'))).toBeUndefined();
    const warning = projection.apply(subagentIteration());
    expect(warning).toMatchObject({
      projection: 'subagent_transcript',
      code: 'storage/agent_run_message_projection_failed',
      retryable: true,
    });

    expect(projection.apply({
      type: 'system_warning',
      level: 'info',
      message: 'retry tick',
    })).toBeUndefined();
    expect(written).toMatchObject([{
      agentRunId: 'subagent-1',
      role: 'assistant',
      content: { text: 'hello' },
    }]);
  });
});

function subagentText(delta: string): EmaStreamEvent {
  return {
    type: 'subagent_stream',
    sessionId: 'session-1',
    subagentId: 'subagent-1',
    ev: {
      type: 'text_delta',
      sessionId: 'session-1',
      subagentId: 'subagent-1',
      delta,
    },
  } as EmaStreamEvent;
}

function subagentIteration(): EmaStreamEvent {
  return {
    type: 'subagent_stream',
    sessionId: 'session-1',
    subagentId: 'subagent-1',
    ev: {
      type: 'iteration',
      sessionId: 'session-1',
      subagentId: 'subagent-1',
      n: 2,
      elapsedMs: 100,
    },
  } as EmaStreamEvent;
}
