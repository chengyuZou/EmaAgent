import type { Message } from '@ema-agent/llm';
import { describe, expect, it } from 'vitest';
import { runTurnExtraction } from '../common/extraction.js';
import { serializeRelationshipTurn } from '../relationship/extraction.js';
import { serializeWorkTurn } from '../work/extraction.js';

const messages: readonly Message[] = [
  { role: 'user', content: '我更喜欢先讨论再改代码' },
  { role: 'assistant', content: [{ type: 'text', text: '明白' }] },
];

describe('Memory Extraction', () => {
  it('两轨只序列化 LLM Message, Relationship 额外携带 characterName', () => {
    expect(serializeWorkTurn({ messages })).toContain('先讨论再改代码');
    expect(serializeRelationshipTurn({ characterName: '艾玛', messages }))
      .toContain('"characterName": "艾玛"');
  });

  it('严格把 {} 解释为空结果', async () => {
    await expect(runTurnExtraction('system', 'input', 'turn', async () => '{}'))
      .resolves.toBeUndefined();
  });

  it.each(['', '   ', '\n\t ', null, []].map(content => ({ content })))(
    '把空 content $content 解释为没有提取内容',
    async ({ content }) => {
      await expect(runTurnExtraction(
        'system',
        'input',
        'turn',
        async () => JSON.stringify({ content }),
      )).resolves.toBeUndefined();
    },
  );

  it.each([['内容'], {}, 0, false].map(content => ({ content })))(
    '不把非空字符串以外的 content $content 当成空结果',
    async ({ content }) => {
      await expect(runTurnExtraction(
        'system',
        'input',
        'turn',
        async () => JSON.stringify({ content }),
      )).rejects.toThrow('content');
    },
  );

  it.each(['null', '[]', '', '{broken}', '{"content":null,"extra":true}'])(
    '仍拒绝错误的对象或 JSON: %s',
    async raw => {
      await expect(runTurnExtraction('system', 'input', 'turn', async () => raw))
        .rejects.toThrow();
    },
  );

  it('保留非空内容并去掉首尾空白', async () => {
    await expect(runTurnExtraction(
      'system',
      'input',
      'turn',
      async () => '{"content":"  偏好 pnpm  "}',
    )).resolves.toBe('偏好 pnpm');
  });

  it('返回 content 并拒绝旧 NO_MEMORY 哨兵', async () => {
    await expect(runTurnExtraction(
      'system',
      'input',
      'turn',
      async () => '{"content":"偏好 pnpm"}',
    )).resolves.toBe('偏好 pnpm');
    await expect(runTurnExtraction('system', 'input', 'turn', async () => 'NO_MEMORY'))
      .rejects.toThrow('not valid JSON');
    await expect(runTurnExtraction(
      'system',
      'input',
      'turn',
      async () => '{"content":"偏好 pnpm","confidence":1}',
    )).rejects.toThrow('contain only content');
  });
});
