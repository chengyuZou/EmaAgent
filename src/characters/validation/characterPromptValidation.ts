// 校验角色 Prompt 的执行硬门，避免资源检查依赖进入每次 Prompt 装配热路径。

import { CharacterPromptInvalidError } from '../errors.js';

export function assertCharacterPrompt(
  systemPrompt: string,
  characterId?: string,
): void {
  if (systemPrompt.trim().length === 0) {
    throw new CharacterPromptInvalidError(characterId);
  }
}
