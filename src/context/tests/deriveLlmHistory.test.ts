// 验证 deriveLlmHistory 的投影规则（丢系统/未配对 Tool 块）、thinking 保留与生成来源携带。
import { describe, expect, it } from 'vitest';
import type { Message as SessionMessage } from '@ema-agent/session';
import { deriveLlmHistory } from '../deriveLlmHistory.js';

const sessionId = 'session-1';
const turnId = 'turn-1';
const noTarget = (): undefined => undefined;

function message(
  id: string,
  role: SessionMessage['role'],
  blocks: SessionMessage['blocks'],
  kind: SessionMessage['kind'] = 'normal',
): SessionMessage {
  return {
    id,
    sessionId,
    turnId,
    role,
    kind,
    blocks,
    interrupted: false,
    createdAt: 1,
  };
}

describe('deriveLlmHistory', () => {
  it('跳过旧系统消息；保留 thinking 并携带所属 Turn 的生成来源', () => {
    const result = deriveLlmHistory([
      message('m1', 'system', '旧系统'),
      message('m2', 'assistant', [
        { type: 'thinking', thinking: '内部思考', signature: 'sig-1' },
        { type: 'text', text: '可见回答' },
      ]),
    ], () => ({
      providerId: 'anthropic',
      modelId: 'claude-sonnet',
      protocol: 'anthropic-llm',
    }));

    expect(result).toEqual([{
      sessionMessageId: 'm2',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '内部思考', signature: 'sig-1' },
          { type: 'text', text: '可见回答' },
        ],
        generatedBy: {
          providerId: 'anthropic',
          modelId: 'claude-sonnet',
          protocol: 'anthropic-llm',
        },
      },
    }]);
  });

  it('无 turnId 或 resolver 无目标时缺省不带 generatedBy', () => {
    const result = deriveLlmHistory([
      { ...message('m1', 'assistant', [{ type: 'text', text: '无 turnId' }]), turnId: null },
      message('m2', 'assistant', [{ type: 'text', text: '有 turnId 但无目标' }]),
    ], noTarget);

    expect(result[0]!.message).toEqual({ role: 'assistant', content: [{ type: 'text', text: '无 turnId' }] });
    expect(result[1]!.message).toEqual({ role: 'assistant', content: [{ type: 'text', text: '有 turnId 但无目标' }] });
  });

  it('user/tool_result 消息不伪造生成来源', () => {
    const result = deriveLlmHistory([
      message('m1', 'assistant', [
        { type: 'tool_use', id: 'paired', name: 'Read', args: { path: 'a.ts' } },
      ]),
      message('m2', 'user', [{
        type: 'tool_result',
        toolCallId: 'paired',
        content: 'file content',
      }]),
    ], () => ({
      providerId: 'anthropic',
      modelId: 'claude-sonnet',
      protocol: 'anthropic-llm',
    }));

    expect(result[0]!.message).toMatchObject({ role: 'assistant' });
    expect(result[1]!.message).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', toolCallId: 'paired', content: 'file content' }],
    });
  });

  it('reasoning 与 gemini_thought 原生块原样投影并携带生成来源', () => {
    const result = deriveLlmHistory([
      message('m1', 'assistant', [
        { type: 'reasoning', id: 'rsn_1', summaryText: '分析', encryptedContent: 'enc-1' },
        { type: 'gemini_thought', text: '思考', thoughtSignature: 'ts-1' },
        { type: 'text', text: '回答' },
      ]),
    ], () => ({
      providerId: 'openai',
      modelId: 'gpt-5.2',
      protocol: 'openai-responses-llm',
    }));

    expect(result).toEqual([{
      sessionMessageId: 'm1',
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', id: 'rsn_1', summaryText: '分析', encryptedContent: 'enc-1' },
          { type: 'gemini_thought', text: '思考', thoughtSignature: 'ts-1' },
          { type: 'text', text: '回答' },
        ],
        generatedBy: {
          providerId: 'openai',
          modelId: 'gpt-5.2',
          protocol: 'openai-responses-llm',
        },
      },
    }]);
  });

  it('被完全过滤的消息不占产出下标（身份不可按下标对齐输入）', () => {
    const result = deriveLlmHistory([
      message('m1', 'user', '   '),
      message('m2', 'user', '有效输入'),
    ], noTarget);

    expect(result).toEqual([{
      sessionMessageId: 'm2',
      message: { role: 'user', content: '有效输入' },
    }]);
  });

  it('只保留完整配对的 tool_use 和 tool_result', () => {
    const result = deriveLlmHistory([
      message('m1', 'assistant', [
        { type: 'tool_use', id: 'paired', name: 'Read', args: { path: 'a.ts' } },
        { type: 'tool_use', id: 'orphan', name: 'Read', args: { path: 'b.ts' } },
      ]),
      message('m2', 'user', [{
        type: 'tool_result',
        toolCallId: 'paired',
        content: 'file content',
      }]),
    ], noTarget);

    expect(result).toEqual([
      {
        sessionMessageId: 'm1',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'paired', name: 'Read', args: { path: 'a.ts' } }],
        },
      },
      {
        sessionMessageId: 'm2',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', toolCallId: 'paired', content: 'file content' }],
        },
      },
    ]);
  });

  it('拒绝结果先于调用或重复使用同一个 toolCallId 的伪配对', () => {
    const result = deriveLlmHistory([
      message('m1', 'user', [{
        type: 'tool_result',
        toolCallId: 'out-of-order',
        content: '提前出现的结果',
      }]),
      message('m2', 'assistant', [
        { type: 'tool_use', id: 'out-of-order', name: 'Read', args: {} },
        { type: 'tool_use', id: 'duplicate', name: 'Read', args: {} },
        { type: 'tool_use', id: 'duplicate', name: 'Read', args: {} },
        { type: 'text', text: '保留文本' },
      ]),
      message('m3', 'user', [{
        type: 'tool_result',
        toolCallId: 'duplicate',
        content: '歧义结果',
      }]),
    ], noTarget);

    expect(result).toEqual([{
      sessionMessageId: 'm2',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '保留文本' }],
      },
    }]);
  });
});
