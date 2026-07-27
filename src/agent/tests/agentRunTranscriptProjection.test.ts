// 测试 AgentRun transcript 的缓冲、辅助落库故障隔离与后续重试。

import { describe, expect, it } from 'vitest';
import type { AgentRunId, SessionId } from '@ema-agent/ids';
import type { AgentRunMessageInsert } from '@ema-agent/storage';
import type { AgentRunEvent } from '../events.js';
import { AgentRunTranscriptProjection } from '../runs/agentRunTranscriptProjection.js';

const sessionId = 'session-1' as SessionId;
const agentRunId = 'subagent-1' as AgentRunId;

describe('AgentRunTranscriptProjection', () => {
  it('落库失败返回结构化 warning，下一条 AgentRun 事件继续重试且不丢正文', () => {
    const written: AgentRunMessageInsert[] = [];
    let failNext = true;
    const projection = new AgentRunTranscriptProjection({
      insert(message) {
        if (failNext) {
          failNext = false;
          throw new Error('database is busy');
        }
        written.push(message);
      },
    });

    expect(projection.apply(subagentText('hello'))).toBeUndefined();
    expect(projection.apply(subagentIteration())).toMatchObject({
      projection: 'subagent_transcript',
      code: 'storage/agent_run_message_projection_failed',
      retryable: true,
    });

    expect(projection.apply({
      type: 'subagent_progress',
      sessionId,
      subagentId: agentRunId,
      iteration: 2,
      elapsedMs: 100,
      toolCallCount: 0,
    })).toBeUndefined();
    expect(written).toMatchObject([{
      agentRunId,
      role: 'assistant',
      content: { text: 'hello' },
    }]);
  });
});

function subagentText(delta: string): AgentRunEvent {
  return {
    type: 'subagent_stream',
    sessionId,
    subagentId: agentRunId,
    ev: {
      type: 'text_delta',
      sessionId,
      subagentId: agentRunId,
      delta,
    },
  };
}

function subagentIteration(): AgentRunEvent {
  return {
    type: 'subagent_stream',
    sessionId,
    subagentId: agentRunId,
    ev: {
      type: 'iteration',
      sessionId,
      subagentId: agentRunId,
      n: 2,
      elapsedMs: 100,
    },
  };
}
