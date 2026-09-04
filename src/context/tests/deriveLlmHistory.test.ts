// 验证 deriveLlmHistory 的投影规则（丢系统/未配对 Tool 块）、thinking 保留与生成来源携带。
import { describe, expect, it } from 'vitest';
import type { Message as SessionMessage } from '@ema-agent/session';
import { deriveLlmHistory } from '../deriveLlmHistory.js';

const sessionId = 'session-1';
const turnId = 'turn-1';
const noTarget = (): undefined => undefined;
const noAttachment = async (): Promise<never> => {
  throw new Error('本用例不应解析附件');
};

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
  it('跳过旧系统消息；保留 thinking 并携带所属 Turn 的生成来源', async () => {
    const result = await deriveLlmHistory([
      message('m1', 'system', '旧系统'),
      message('m2', 'assistant', [
        { type: 'thinking', thinking: '内部思考', signature: 'sig-1' },
        { type: 'text', text: '可见回答' },
      ]),
    ], () => ({
      providerId: 'anthropic',
      modelId: 'claude-sonnet',
      protocol: 'anthropic-llm',
    }), noAttachment);

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

  it('无 turnId 或 resolver 无目标时缺省不带 generatedBy', async () => {
    const result = await deriveLlmHistory([
      { ...message('m1', 'assistant', [{ type: 'text', text: '无 turnId' }]), turnId: null },
      message('m2', 'assistant', [{ type: 'text', text: '有 turnId 但无目标' }]),
    ], noTarget, noAttachment);

    expect(result[0]!.message).toEqual({ role: 'assistant', content: [{ type: 'text', text: '无 turnId' }] });
    expect(result[1]!.message).toEqual({ role: 'assistant', content: [{ type: 'text', text: '有 turnId 但无目标' }] });
  });

  it('user/tool_result 消息不伪造生成来源', async () => {
    const result = await deriveLlmHistory([
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
    }), noAttachment);

    expect(result[0]!.message).toMatchObject({ role: 'assistant' });
    expect(result[1]!.message).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', toolCallId: 'paired', content: 'file content' }],
    });
  });

  it('reasoning 与 gemini_thought 原生块原样投影并携带生成来源', async () => {
    const result = await deriveLlmHistory([
      message('m1', 'assistant', [
        { type: 'reasoning', id: 'rsn_1', summaryText: '分析', encryptedContent: 'enc-1' },
        { type: 'gemini_thought', text: '思考', thoughtSignature: 'ts-1' },
        { type: 'text', text: '回答' },
      ]),
    ], () => ({
      providerId: 'openai',
      modelId: 'gpt-5.2',
      protocol: 'openai-responses-llm',
    }), noAttachment);

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

  it('被完全过滤的消息不占产出下标（身份不可按下标对齐输入）', async () => {
    const result = await deriveLlmHistory([
      message('m1', 'user', '   '),
      message('m2', 'user', '有效输入'),
    ], noTarget, noAttachment);

    expect(result).toEqual([{
      sessionMessageId: 'm2',
      message: { role: 'user', content: '有效输入' },
    }]);
  });

  it('Skill 引用只投影选择记录，不把 SKILL.md 正文写进历史', async () => {
    const result = await deriveLlmHistory([
      message('m1', 'user', [{
        type: 'skill_reference',
        name: 'pdf',
        path: 'D:\\skills\\pdf\\SKILL.md',
      }]),
    ], noTarget, noAttachment);

    expect(result).toEqual([{
      sessionMessageId: 'm1',
      message: {
        role: 'user',
        content: [{
          type: 'text',
          text: [
            '[用户选择的 Skill: pdf (D:\\skills\\pdf\\SKILL.md)]',
            '这是用户的选择记录。若该技能当前可用,可调用 Skill 工具加载它的完整指令;若已被删除或禁用,Skill 工具会返回不可用,忽略即可。',
          ].join('\n'),
        }],
      },
    }]);
  });

  it('附件引用由 Turn 注入的解析函数投影，当前输入与历史不使用占位符', async () => {
    const result = await deriveLlmHistory([
      message('m1', 'user', [{
        type: 'attachment_ref',
        attachmentId: 'att-1',
        name: 'cat.png',
        mimeType: 'image/png',
      }]),
    ], noTarget, async reference => ({
      type: 'text',
      text: `稳定描述:${reference.attachmentId}`,
    }));

    expect(result[0]!.message).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '稳定描述:att-1' }],
    });
  });

  it('中断的 Assistant 消息不进入下一轮模型历史', async () => {
    const interrupted = {
      ...message('m1', 'assistant', [{ type: 'text', text: '半截回答' }]),
      interrupted: true,
    };
    const result = await deriveLlmHistory([
      interrupted,
      message('m2', 'user', '继续'),
    ], noTarget, noAttachment);

    expect(result).toEqual([{
      sessionMessageId: 'm2',
      message: { role: 'user', content: '继续' },
    }]);
  });

  it('只保留完整配对的 tool_use 和 tool_result', async () => {
    const result = await deriveLlmHistory([
      message('m1', 'assistant', [
        { type: 'tool_use', id: 'paired', name: 'Read', args: { path: 'a.ts' } },
        { type: 'tool_use', id: 'orphan', name: 'Read', args: { path: 'b.ts' } },
      ]),
      message('m2', 'user', [{
        type: 'tool_result',
        toolCallId: 'paired',
        content: 'file content',
      }]),
    ], noTarget, noAttachment);

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

  it('中断 Assistant 的 tool_use 与后续取消结果整对排除', async () => {
    const interrupted = {
      ...message('m1', 'assistant', [{
        type: 'tool_use', id: 'cancelled', name: 'Bash', args: { command: 'sleep 10' },
      }]),
      interrupted: true,
    };
    const result = await deriveLlmHistory([
      interrupted,
      message('m2', 'user', [{
        type: 'tool_result',
        toolCallId: 'cancelled',
        content: '[Turn 中断，工具调用未产生结果]',
        isError: true,
      }]),
      message('m3', 'user', '新的请求'),
    ], noTarget, noAttachment);

    expect(result).toEqual([{
      sessionMessageId: 'm3',
      message: { role: 'user', content: '新的请求' },
    }]);
  });

  it('拒绝结果先于调用或重复使用同一个 toolCallId 的伪配对', async () => {
    const result = await deriveLlmHistory([
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
    ], noTarget, noAttachment);

    expect(result).toEqual([{
      sessionMessageId: 'm2',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '保留文本' }],
      },
    }]);
  });
});
