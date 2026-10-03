// 验证根循环事件的前端投影, Context 校正及根/子物理调用记账.
import { describe, expect, it, vi } from 'vitest';
import type { AgentLoopEvent } from '@ema-agent/agent';
import type { UsageRecord } from '@ema-agent/usage';
import type { TurnStreamEvent } from '../events.js';
import { createTurnLoopEvents } from '../turnLoopEvents.js';

function fixture() {
  const events: TurnStreamEvent[] = [];
  const records: UsageRecord[] = [];
  const writer = { currentAssistantMessageId: 'stored-assistant' };
  const setIterations = vi.fn();
  const loop = createTurnLoopEvents({
    sessionId: 'session', turnId: 'turn', writer, turns: { setIterations },
    usageRecorder: { record: record => { records.push(record); } },
    emit: event => { events.push(event); },
  });
  return { loop, events, records, writer, setIterations };
}

function finished(llmCallId: string): Extract<AgentLoopEvent, { type: 'llm_call_finished' }> {
  return {
    type: 'llm_call_finished', llmCallId,
    source: { providerId: 'p', modelId: 'm', protocol: 'openai-llm' },
    status: 'completed', usage: { inputTokens: 10, outputTokens: 5 },
    startedAt: 100, durationMs: 20,
  };
}

describe('根 Turn 循环事件', () => {
  it('事件读取 writer 已落库的 Assistant ID, 工具结果沿用对应工具名', () => {
    const { loop, events, writer, setIterations } = fixture();
    loop.accept({ type: 'iteration_started', iteration: 2, continuesOutput: false,
      state: { phase: 'thinking', iterations: 2, usage: { inputTokens: 0, outputTokens: 0 } } });
    loop.accept({ type: 'tool_use_completed', blockIndex: 1, toolCallId: 'call',
      toolName: 'Read', args: { path: 'README.md' } });
    writer.currentAssistantMessageId = 'next-assistant';
    loop.accept({ type: 'text_delta', blockIndex: 0, delta: '结果' });
    loop.accept({ type: 'tool_result', result: { type: 'tool_result', toolCallId: 'call',
      content: '正文', data: { text: '结构化正文' }, durationMs: 7 } });
    loop.accept({ type: 'tool_result', result: { type: 'tool_result', toolCallId: 'call',
      content: '没有权限', isError: true, errorCode: 'tool/denied' } });
    expect(setIterations).toHaveBeenCalledWith('turn', 2);
    expect(events).toEqual([
      { type: 'agent_iteration', sessionId: 'session', turnId: 'turn', n: 2,
        assistantMessageId: 'stored-assistant' },
      { type: 'tool_call_complete', sessionId: 'session', turnId: 'turn', blockIndex: 1,
        callId: 'call', name: 'Read', args: { path: 'README.md' }, assistantMessageId: 'stored-assistant' },
      { type: 'output_text_delta', sessionId: 'session', turnId: 'turn', blockIndex: 0,
        delta: '结果', assistantMessageId: 'next-assistant' },
      { type: 'tool_result', sessionId: 'session', callId: 'call', name: 'Read',
        output: { text: '结构化正文' }, durationMs: 7 },
      { type: 'tool_result', sessionId: 'session', callId: 'call', name: 'Read',
        error: { code: 'tool/denied', message: '没有权限' }, durationMs: 0 },
    ]);
  });

  it('估算先交付, Provider 校正后追加历史改回估算, 旧请求的追加不污染当前圆环', () => {
    const { loop, events } = fixture();
    loop.onContextPrepared('root', { contextWindow: 1000, estimatedInputTokens: 30, accuracy: 'heuristic' });
    loop.accept({ type: 'llm_call_usage_updated', llmCallId: 'root',
      usage: { inputTokens: 40, outputTokens: 5, cacheReadInputTokens: 10 } });
    loop.accept({ type: 'model_history_appended', llmCallId: 'root',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: '追加回复' }] }] });
    const updates = events.filter(event => event.type === 'context_usage_updated');
    expect(updates.map(event => event.usage.source)).toEqual(['estimate', 'provider', 'estimate']);
    expect(updates[1]?.usage).toMatchObject({ inputTokens: 40, cacheReadInputTokens: 10 });
    expect(updates[2]?.usage.inputTokens).toBeGreaterThan(40);
    loop.onContextPrepared('next', { contextWindow: 1000, estimatedInputTokens: 60, accuracy: 'heuristic' });
    const count = events.length;
    loop.accept({ type: 'model_history_appended', llmCallId: 'root',
      messages: [{ role: 'user', content: '旧请求结果' }] });
    loop.accept({ type: 'llm_call_usage_updated', llmCallId: 'child',
      usage: { inputTokens: 200, outputTokens: 20 } });
    expect(events).toHaveLength(count);
  });

  it('根与子调用分别记录实际来源, 子调用不发根 Context 事件, 无用量的失败保存空值', () => {
    const { loop, records, events } = fixture();
    loop.accept(finished('root'));
    loop.recordLlmCall({ ...finished('child'),
      source: { providerId: 'child-provider', modelId: 'child-model', protocol: 'anthropic-llm' } });
    const { usage: _usage, ...failure } = finished('failed');
    loop.recordLlmCall({ ...failure, status: 'failed', errorCode: 'llm/failed' });
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ id: 'root', sessionId: 'session', turnId: 'turn',
      providerId: 'p', modelId: 'm', capability: 'llm', inputTokens: 10, outputTokens: 5,
      durationMs: 20, createdAt: 100 });
    expect(records[1]).toMatchObject({ id: 'child', providerId: 'child-provider', modelId: 'child-model',
      sessionId: 'session', turnId: 'turn' });
    expect(records[2]).toMatchObject({ status: 'failed', errorCode: 'llm/failed', inputTokens: null,
      outputTokens: null, cacheReadInputTokens: null, cacheWriteInputTokens: null });
    expect(events).toEqual([]);
  });
});
