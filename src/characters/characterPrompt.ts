// 装配角色人设提示词，并根据本 Turn 的舞台呈现追加表达控制协议。

import type { Character, CharacterStagePresentation } from './types.js';
import { CharacterPromptInvalidError } from './errors.js';

/**
 * 装配角色 Prompt：人设提示词（personaPrompt）在前，追加不可由用户编辑的
 * 舞台表达控制协议。这里只守身份硬门——拼起来为空就拒，空人设角色不能启动新 Turn。
 */
export function buildCharacterPrompt(
  character: Character,
  presentation: CharacterStagePresentation,
): readonly string[] {
  const sections = [
    character.personaPrompt,
    buildStageControlPrompt(presentation),
  ].filter(hasContent);
  if (sections.length === 0) {
    throw new CharacterPromptInvalidError('角色人设提示词不能为空', character.name);
  }
  return sections;
}

/** 空人设会让新 Turn 失去身份：非空 + 不允许内嵌 Live2D 控制标签（会被误解析）。 */
export function assertPersonaPrompt(
  personaPrompt: string,
  characterName?: string,
): void {
  const content = personaPrompt.trim();
  if (!content) {
    throw new CharacterPromptInvalidError('角色人设提示词不能为空', characterName);
  }
  if (containsStageControlTag(content)) {
    throw new CharacterPromptInvalidError(
      '角色人设提示词不能包含 <emotion> 或 <motion> 控制标签',
      characterName,
    );
  }
}

function containsStageControlTag(content: string): boolean {
  return /<\s*\/?\s*(?:emotion|motion)(?:\s|>|\/|$)/iu.test(content);
}

/**
 * 舞台控制协议：Live2D 读取 runtime-config.json 的映射键，立绘读取 expression 分组。
 * 它不是 Prompt Block，不落表、不可排序禁用编辑、不计入字符限制。
 */
export function buildStageControlPrompt(presentation: CharacterStagePresentation): string {
  const { emotions, motions } = characterStageVocabulary(presentation);
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

只使用上面列出的名称。需要更换角色表现时输出标签，同一情绪也可以再次输出以切换另一张立绘。不要输出无法确认存在的名称。`;
}

export function characterStageVocabulary(
  presentation: CharacterStagePresentation,
): { readonly emotions: readonly string[]; readonly motions: readonly string[] } {
  if (presentation.status === 'live2d') {
    return {
      emotions: Object.keys(presentation.resource.runtimeConfig?.emotionMap ?? {}),
      motions: Object.keys(presentation.resource.runtimeConfig?.motionMap ?? {}),
    };
  }
  if (presentation.status === 'illustration') {
    return { emotions: Object.keys(presentation.expressions), motions: [] };
  }
  return { emotions: [], motions: [] };
}

function formatVocabulary(values: readonly string[]): string {
  return values.length > 0
    ? values.map((value) => `\`${value}\``).join(' / ')
    : '无';
}

function hasContent(text: string): boolean {
  return text.trim().length > 0;
}
