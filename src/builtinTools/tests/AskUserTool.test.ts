// AskUserTool 收口测试: 问询通道要求、spec 构造、答案键归一(问题文本)、map 投影。
import { describe, expect, it, vi } from 'vitest';
import { asSessionId, asToolCallId, asTurnId } from '@ema-agent/ids';
import type { ToolInvocation } from '@ema-agent/tools';
import { AskUserTool } from '../tools/AskUserTool/AskUserTool.js';

function makeInvocation(): ToolInvocation {
  return {
    sessionId: asSessionId('00000000-0000-4000-8000-0000000000b1'),
    turnId: asTurnId('00000000-0000-4000-8000-0000000000b2'),
    toolCallId: asToolCallId('call-ask-1'),
    signal: new AbortController().signal,
  };
}

const QUESTIONS = [
  {
    question: '选哪种方案？',
    header: '方案',
    options: [{ label: 'A' }, { label: 'B' }],
    multiSelect: false,
  },
  {
    question: '节奏怎么定？',
    header: '节奏',
    options: [{ label: '先跑通' }, { label: '一次到位' }],
    multiSelect: false,
  },
] as const;

describe('AskUserTool', () => {
  it('没有 askUser 通道时投影失败(不暴露工具)', () => {
    const verdict = AskTool_validateContext({});
    expect(verdict.valid).toBe(false);
  });

  it('构造的 request 携带 sessionId/turnId/promptId/specs', async () => {
    const askUser = vi.fn().mockResolvedValue({ answers: {} });
    await AskUserTool.execute(
      { questions: [...QUESTIONS] },
      { askUser },
      makeInvocation(),
    );

    const [promptId, specs, request] = askUser.mock.calls[0]!;
    expect(typeof promptId).toBe('string');
    expect(specs[0]).toMatchObject({ id: 'q0', question: '选哪种方案？' });
    expect(request).toMatchObject({
      type: 'ask_user_required',
      turnId: '00000000-0000-4000-8000-0000000000b2',
      promptId,
    });
  });

  it('答案键从 spec id 归一为问题文本;缺答给空串', async () => {
    const askUser = vi.fn().mockResolvedValue({ answers: { q0: 'A' } });
    const result = await AskUserTool.execute(
      { questions: [...QUESTIONS] },
      { askUser },
      makeInvocation(),
    );

    expect(result.answers).toEqual({ '选哪种方案？': 'A', '节奏怎么定？': '' });
  });

  it('options 必填(2-4): 缺 options 或重复 label 都被 Schema 拒绝', () => {
    const noOptions = AskUserTool.inputSchema.safeParse({
      questions: [{ question: 'q', header: 'h', multiSelect: false }],
    });
    expect(noOptions.success).toBe(false);
    const dupLabel = AskUserTool.inputSchema.safeParse({
      questions: [{ question: 'q', header: 'h', options: [{ label: 'A' }, { label: 'A' }] }],
    });
    expect(dupLabel.success).toBe(false);
    const dupQuestion = AskUserTool.inputSchema.safeParse({
      questions: [
        { question: 'q', header: 'h1', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'q', header: 'h2', options: [{ label: 'A' }, { label: 'B' }] },
      ],
    });
    expect(dupQuestion.success).toBe(false);
  });

  it('map 投影为 Q/A 文本行', () => {
    const out = AskUserTool.mapResultToModelContent!({
      answers: { '选哪种方案？': 'A', '备注？': '' },
    });
    expect(out).toContain('Q: 选哪种方案？');
    expect(out).toContain('A: A');
    expect(out).toContain('(no answer)');
  });
});

function AskTool_validateContext(host: Record<string, unknown>) {
  return AskUserTool.validateContext(host as never);
}
