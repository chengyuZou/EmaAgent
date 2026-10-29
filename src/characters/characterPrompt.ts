
import type { Character, CharacterStagePresentation } from './types.js';
import { CharacterPromptInvalidError } from './errors.js';

/** 人设正文不必重复姓名, 当前身份由 Character.name 单独写明. */
export function buildCharacterPrompt(
  character: Character,
  presentation: CharacterStagePresentation,
  stickerPrompt = '',
): readonly string[] {
  const sections = [
    character.personaPrompt,
    buildStageControlPrompt(presentation),
    stickerPrompt,
  ].filter(hasContent);
  if (sections.length === 0) {
    throw new CharacterPromptInvalidError('角色人设提示词不能为空', character.name);
  }
  return [`当前角色: ${character.name}`, ...sections];
}

/** 人设必须非空, 且不能包含会被 Stage 当成控制指令的标签. */
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
 * 从实际 Presentation 生成可用标签, 避免 Prompt 让模型输出不存在的表情或动作.
 * 与角色正文一同交给 prompts 包, 不单独保存为可编辑的 Prompt Block.
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
    sections.push(`情绪标签:<emotion>name</emotion>
可用情绪:${formatVocabulary(emotions)}
示例:<emotion>${emotionExample}</emotion>`);
  }
  if (motionExample) {
    sections.push(`动作标签:<motion>name</motion>
可用动作:${formatVocabulary(motions)}
示例:<motion>${motionExample}</motion>`);
  }

  const usageRule = presentation.status === 'illustration'
    ? '情绪标签会从对应的立绘组中选择图片;同组有多张图片时,再次输出相同情绪标签也可以切换到另一张.'
    : '情绪标签控制 Live2D 表情,动作标签触发可用动作;只在需要改变表现时输出对应标签.';

  return `## 角色表达控制协议

你可以在回复正文中插入以下控制标签来表达角色的情绪和动作.控制标签会被系统解析,不要向用户解释,引用或讨论标签本身.

${sections.join('\n\n')}

${usageRule}只使用上面列出的名称,不要输出无法确认存在的名称.`;
}

export function characterStageVocabulary(
  presentation: CharacterStagePresentation,
): { readonly emotions: readonly string[]; readonly motions: readonly string[] } {
  if (presentation.status === 'live2d') {
    return {
      emotions: Object.keys(presentation.resource.emotionMap),
      motions: Object.keys(presentation.resource.motionMap),
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
