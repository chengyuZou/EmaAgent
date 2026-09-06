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
  it('两轨只序列化 LLM Message，Relationship 额外携带 characterName', () => {
    expect(serializeWorkTurn({ messages })).toContain('先讨论再改代码');
    expect(serializeRelationshipTurn({ characterName: '艾玛', messages }))
      .toContain('"characterName": "艾玛"');
  });

  it('严格把 {} 解释为空结果', async () => {
    await expect(runTurnExtraction('system', 'input', 'turn', async () => '{}'))
      .resolves.toBeUndefined();
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
