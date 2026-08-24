// 装配角色人设提示词，最后追加不可由用户编辑的 Live2D 控制协议。

import type { Character } from './types.js';
import { CharacterPromptInvalidError } from './errors.js';

/**
 * 装配角色 Prompt：人设提示词（personaPrompt）在前，追加不可由用户编辑的
 * Live2D 控制协议。这里只守身份硬门——拼起来为空就拒，空人设角色不能启动新 Turn。
 */
export function buildCharacterPrompt(character: Character): readonly string[] {
  const sections = [
    character.personaPrompt,
    buildLive2dControlPrompt(character),
  ].filter(hasContent);
  if (sections.length === 0) {
    throw new CharacterPromptInvalidError('角色人设提示词不能为空', character.id);
  }
  return sections;
}

/** 空人设会让新 Turn 失去身份：非空 + 不允许内嵌 Live2D 控制标签（会被误解析）。 */
export function assertPersonaPrompt(
  personaPrompt: string,
  characterId?: string,
): void {
  const content = personaPrompt.trim();
  if (!content) {
    throw new CharacterPromptInvalidError('角色人设提示词不能为空', characterId);
  }
  if (containsLive2dControlTag(content)) {
    throw new CharacterPromptInvalidError(
      '角色人设提示词不能包含 <emotion> 或 <motion> 控制标签',
      characterId,
    );
  }
}

function containsLive2dControlTag(content: string): boolean {
  return /<\s*\/?\s*(?:emotion|motion)(?:\s|>|\/|$)/iu.test(content);
}

/**
 * Live2D 控制协议：只消费当前主用 Live2D 已提取的 emotion/motion 词汇。
 * 它不是 Prompt Block，不落表、不可排序禁用编辑、不计入字符限制。
 */
export function buildLive2dControlPrompt(character: Character): string {
  const emotions = character.emotionVocabulary;
  const motions = character.motionVocabulary;
  if (emotions.length === 0 && motions.length === 0) {
    return '';
  }

  const emotionExample = emotions[0];
  const motionExample = motions[0];

  const sections: string[] = [];
  if (emotionExample) {
    sections.push(`情绪标签：<emotion>name</emotion>
可用情绪：${formatVocabulary(emotions)}
示例：<emotion>${emotionExample}</emotion>`);
  }
  if (motionExample) {
    sections.push(`动作标签：<motion>name</motion>
可用动作：${formatVocabulary(motions)}
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

function hasContent(text: string): boolean {
  return text.trim().length > 0;
}
