// 测试 PromptBuilder 只装配稳定指令，并正确表达 Chat/Work 与 Narrative 策略。

import { describe, expect, it } from 'vitest';
import {
  EMA_CARD_ID,
  emptyVoiceProfile,
  type CharacterCard,
} from '@ema-agent/characters';
import { buildPromptSnapshot } from '../promptBuilder.js';
import type { PromptSlotContribution } from '../types.js';

function character(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    id: EMA_CARD_ID,
    name: 'Test',
    version: 'v1.0.0',
    description: null,
    systemPrompt: 'You are a helpful test assistant.',
    speechPatterns: [],
    forbiddenTopics: [],
    emotionVocabulary: ['happy', 'sad'],
    motionVocabulary: ['wave', 'nod'],
    live2dModelId: null,
    voiceProfile: emptyVoiceProfile(),
    isActive: true,
    isBuiltin: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('buildPromptSnapshot', () => {
  it('按产品、角色、Profile 的稳定顺序组装 Chat Prompt', () => {
    const snapshot = buildPromptSnapshot({
      activeCharacter: character(),
      executionProfile: 'chat',
      narrativePolicy: 'auto',
    });

    expect(snapshot.slots.map((slot) => slot.id)).toEqual([
      'product.rules',
      'product.toolGuidance',
      'character.identity',
      'character.presentation',
      'profile.execution',
    ]);
    const systemText = snapshot.systemBlocks.map((block) => block.content).join('\n\n');
    expect(systemText).toContain('当前执行方式：Chat');
    expect(systemText).toContain('剧情资料策略：自动');
    expect(systemText).toContain('You are a helpful test assistant.');
    expect(systemText).toContain('## 角色表达控制协议');
    expect(systemText).not.toContain('当前允许操作的工作区目录');
    expect(snapshot.systemBlocks.map((block) => block.stabilityScope)).toEqual([
      'product',
      'activeCharacter',
      'turn',
    ]);
  });

  it('在 Work Prompt 中把 Skill Catalog 作为非 System 扩展上下文', () => {
    const skillCatalog: PromptSlotContribution = {
      id: 'extension.skillCatalog',
      content: '## 可用技能\n- summarize',
      version: 'skills:1',
    };
    const snapshot = buildPromptSnapshot({
      activeCharacter: character(),
      executionProfile: 'work',
      narrativePolicy: 'always',
      extensionContributions: [skillCatalog],
    });

    const systemText = snapshot.systemBlocks.map((block) => block.content).join('\n\n');
    expect(systemText).toContain('当前执行方式：Work');
    expect(systemText).toContain('剧情资料策略：始终检索');
    expect(snapshot.contextBlocks[0]?.content).toContain('## 可用技能');
    expect(snapshot.slots.find((slot) => slot.id === 'extension.skillCatalog')).toEqual(
      expect.objectContaining({
        stabilityScope: 'turn',
        delivery: 'context',
        trust: 'extension',
      }),
    );
  });

  it('Narrative 关闭只影响检索提示，不移除角色指令', () => {
    const snapshot = buildPromptSnapshot({
      activeCharacter: character({ systemPrompt: '始终保持艾玛的角色身份。' }),
      executionProfile: 'chat',
      narrativePolicy: 'off',
    });

    const systemText = snapshot.systemBlocks.map((block) => block.content).join('\n\n');
    expect(systemText).toContain('剧情资料策略：关闭');
    expect(systemText).toContain('角色基础设定仍然有效');
    expect(systemText).toContain('始终保持艾玛的角色身份。');
  });

  it('Profile 或 Narrative 策略变化会生成不同 revision', () => {
    const base = { activeCharacter: character() };
    const chat = buildPromptSnapshot({
      ...base,
      executionProfile: 'chat',
      narrativePolicy: 'auto',
    });
    const work = buildPromptSnapshot({
      ...base,
      executionProfile: 'work',
      narrativePolicy: 'auto',
    });
    const narrativeOff = buildPromptSnapshot({
      ...base,
      executionProfile: 'chat',
      narrativePolicy: 'off',
    });

    expect(chat.revision).not.toBe(work.revision);
    expect(chat.revision).not.toBe(narrativeOff.revision);
    expect(chat.revisions.product).toBe(work.revisions.product);
    expect(chat.revisions.activeCharacter).toBe(work.revisions.activeCharacter);
    expect(chat.revisions.turn).not.toBe(work.revisions.turn);
  });
});
