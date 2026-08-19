// 校验并平铺角色 Prompt Block，最后追加不可由用户编辑的 Live2D 控制协议。

import type { Character, CharacterPromptBlock } from './types.js';
import { CharacterPromptInvalidError } from './errors.js';
import type { CharacterSettings } from './settings.js';

export interface CharacterPromptLimitIssue {
  readonly characterId: string;
  readonly blockId?: string;
  readonly message: string;
}

/** Prompt 只装配片段，角色文案及其表达协议由 Character 领域提供。 */
export function buildCharacterPrompt(
  character: Character,
  limits: CharacterSettings['prompt'],
): readonly string[] {
  // 数据库可能被用户手工修改；模型请求边界必须重新验证当前真实内容。
  assertCharacterPromptBlocks(character.promptBlocks, limits, character.id);
  return [
    ...character.promptBlocks
      .filter((block) => block.enabled)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((block) => block.content),
    buildLive2dControlPrompt(character),
  ].filter(hasContent);
}

/** 空角色 Prompt 会让新 Turn 失去身份，因此在激活与装配边界直接拒绝。 */
export function assertCharacterPromptBlocks(
  blocks: readonly CharacterPromptBlock[],
  limits: CharacterSettings['prompt'],
  characterId?: string,
): void {
  if (blocks.length === 0) {
    throw new CharacterPromptInvalidError('角色至少需要一个 Prompt Block', characterId);
  }
  if (blocks.length > limits.maxBlocks) {
    throw new CharacterPromptInvalidError(
      `Prompt Block 数量超过上限 ${limits.maxBlocks}`,
      characterId,
    );
  }

  let totalChars = 0;
  let enabledBlocks = 0;
  for (const block of blocks) {
    const name = block.name.trim();
    const content = block.content.trim();
    if (!name) {
      throw new CharacterPromptInvalidError('Prompt Block 名称不能为空', characterId, block.id);
    }
    if (name.length > limits.maxBlockNameChars) {
      throw new CharacterPromptInvalidError(
        `Prompt Block 名称超过 ${limits.maxBlockNameChars} 字符`,
        characterId,
        block.id,
      );
    }
    if (!content) {
      throw new CharacterPromptInvalidError('Prompt Block 内容不能为空', characterId, block.id);
    }
    if (content.length > limits.maxBlockChars) {
      throw new CharacterPromptInvalidError(
        `单个 Prompt Block 超过 ${limits.maxBlockChars} 字符`,
        characterId,
        block.id,
      );
    }
    if (containsLive2dControlTag(content)) {
      throw new CharacterPromptInvalidError(
        'Prompt Block 不能包含 <emotion> 或 <motion> 控制标签',
        characterId,
        block.id,
      );
    }
    totalChars += content.length;
    if (block.enabled) enabledBlocks += 1;
  }
  if (totalChars > limits.maxTotalChars) {
    throw new CharacterPromptInvalidError(
      `角色 Prompt 总字符数超过 ${limits.maxTotalChars}`,
      characterId,
    );
  }
  if (enabledBlocks === 0) {
    throw new CharacterPromptInvalidError('角色至少需要一个启用的 Prompt Block', characterId);
  }
}

/** Settings 保存更小上限前，用同一套领域规则检查全部现有角色。 */
export function validateCharacterPromptLimits(
  limits: CharacterSettings['prompt'],
  characters: readonly Character[],
): CharacterPromptLimitIssue[] {
  const issues: CharacterPromptLimitIssue[] = [];
  for (const character of characters) {
    try {
      assertCharacterPromptBlocks(character.promptBlocks, limits, character.id);
    } catch (error) {
      if (!(error instanceof CharacterPromptInvalidError)) throw error;
      issues.push({
        characterId: character.id,
        blockId: error.blockId,
        message: error.reason,
      });
    }
  }
  return issues;
}

/** 写入数据库前统一裁掉首尾空白，避免 UI 与模型看到两套文本。 */
export function normalizePromptBlock(
  block: Pick<CharacterPromptBlock, 'name' | 'content' | 'enabled'>,
): Pick<CharacterPromptBlock, 'name' | 'content' | 'enabled'> {
  return {
    name: block.name.trim(),
    content: block.content.trim(),
    enabled: block.enabled,
  };
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
