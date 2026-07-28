// 测试 AgentRun transcript 的领域映射、缓冲、辅助落库故障隔离与后续重试。

import { describe, expect, it } from 'vitest';
import type { AgentRunId, SessionId } from '@ema-agent/ids';
import type { AgentRunEvent } from '../events.js';
import { AgentRunTranscriptProjection } from '../runs/agentRunTranscriptProjection.js';
import { AgentRunTranscriptStore } from '../runs/agentRunTranscriptStore.js';
import type { AgentRunTranscriptAppend } from '../runs/types.js';

const sessionId = 'session-1' as SessionId;
const agentRunId = 'subagent-1' as AgentRunId;

describe('AgentRunTranscriptProjection', () => {
  it('落库失败返回结构化 warning，下一条 AgentRun 事件继续重试且不丢正文', () => {
    const written: AgentRunTranscriptAppend[] = [];
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

  it('查询时把 SQLite 行转换为领域 transcript，不向调用方暴露 JSON 列', () => {
    const store = new AgentRunTranscriptStore({
      insert() {},
      listForRun() {
        return [{
          id: 'message-1',
          agent_run_id: agentRunId,
          role: 'assistant',
          content_json: JSON.stringify({ text: '完成' }),
          sequence: 1,
          created_at: 123,
        }];
      },
    });

    expect(store.listForRun(agentRunId)).toEqual([{
      id: 'message-1',
      agentRunId,
      role: 'assistant',
      content: { text: '完成' },
      sequence: 1,
      createdAt: 123,
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
