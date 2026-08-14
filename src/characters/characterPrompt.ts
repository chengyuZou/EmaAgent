import type { CharacterCard } from './types.js';
import { CharacterPromptInvalidError } from './errors.js';

export interface CharacterPrompt {
  prompt: string;
  presentation: string;
}

/** Prompt 只装配片段，角色文案及其表达协议由 Character 领域提供。 */
export function buildCharacterPrompt(
  card: CharacterCard,
): CharacterPrompt {
  // 数据库可能被旧版本或外部工具直接改坏；每次新模型请求仍在领域边界拒绝空 Prompt。
  assertCharacterPrompt(card.systemPrompt, card.id);
  return {
    prompt: card.systemPrompt,
    presentation: buildActProtocolPrompt(card),
  };
}

/** 空角色 Prompt 会让新 Turn 失去身份，因此在激活与装配边界直接拒绝。 */
export function assertCharacterPrompt(
  systemPrompt: string,
  characterId?: string,
): void {
  if (systemPrompt.trim().length === 0) {
    throw new CharacterPromptInvalidError(characterId);
  }
}

function buildActProtocolPrompt(card: CharacterCard): string {
  if (card.emotionVocabulary.length === 0 && card.motionVocabulary.length === 0) {
    return '';
  }

  const emotions = formatVocabulary(card.emotionVocabulary);
  const motions = formatVocabulary(card.motionVocabulary);
  const emotionExample = card.emotionVocabulary[0];
  const motionExample = card.motionVocabulary[0];

  const sections: string[] = [];
  if (emotionExample) {
    sections.push(`情绪标签：<emotion>NAME</emotion>
可用情绪：${emotions}
示例：<emotion>${emotionExample}</emotion>`);
  }
  if (motionExample) {
    sections.push(`动作标签：<motion>NAME</motion>
可用动作：${motions}
示例：<motion>${motionExample}</motion>`);
  }

  return `## 角色表达控制协议

你可以在回复正文中插入以下控制标签来表达角色的情绪和动作。控制标签会被系统解析，不要向用户解释、引用或讨论标签本身。

${sections.join('\n\n')}

只使用上面列出的名称。不要连续重复相同状态，也不要输出无法确认存在的名称。`;
}

function formatVocabulary(values: readonly string[]): string {
  return values.length > 0
    ? values.map((value) => `\`${value}\``).join(' / ')
    : '无';
}
