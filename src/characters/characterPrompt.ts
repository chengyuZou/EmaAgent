import type { CharacterCard } from './types.js';
import { assertCharacterPrompt } from './validation/characterPromptValidation.js';

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

function buildActProtocolPrompt(card: CharacterCard): string {
  const emotions = formatVocabulary(card.emotionVocabulary);
  const motions = formatVocabulary(card.motionVocabulary);
  const emotionExample = card.emotionVocabulary[0];
  const motionExample = card.motionVocabulary[0];

  return `## 角色表达控制协议

你可以在回复正文中插入 ACT 控制标签来表达角色的情绪、动作和停顿。控制标签会被系统解析，不要向用户解释、引用或讨论标签本身。

情绪标签：<|ACT:emotion:NAME|>
可用情绪：${emotions}${emotionExample ? `\n示例:<|ACT:emotion:${emotionExample}|>` : ''}

动作标签：<|ACT:motion:NAME|>
可用动作：${motions}${motionExample ? `\n示例:<|ACT:motion:${motionExample}|>` : ''}

停顿标签：<|DELAY:N|>
N 为秒数，例如 <|DELAY:0.5|>。

只使用上面列出的情绪和动作名称。不要连续重复相同状态，也不要输出无法确认存在的名称。`;
}

function formatVocabulary(values: readonly string[]): string {
  return values.length > 0
    ? values.map((value) => `\`${value}\``).join(' / ')
    : '无';
}
