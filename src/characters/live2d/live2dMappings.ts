import { CharacterResourceValidationError } from '../errors.js';
import type { Live2dMappings, Live2dNativeMotion } from './types.js';

const VOCABULARY_NAME = /^[a-z][a-z0-9_]*$/u;

/** 映射保存到数据库前确认语义词及原生目标, 避免 Prompt 提供无法执行的名称. */
export function assertLive2dMappings(
  mappings: Live2dMappings,
  expressions: readonly string[],
  motions: readonly Live2dNativeMotion[],
): void {
  const expressionNames = new Set(expressions);
  const motionNames = new Set(motions.map(motion => `${motion.group}:${motion.index}`));
  for (const [word, target] of Object.entries(mappings.emotionMap)) {
    if (!VOCABULARY_NAME.test(word) || !expressionNames.has(target.expression)) {
      throw new CharacterResourceValidationError('live2d_mapping_target_invalid');
    }
  }
  for (const [word, target] of Object.entries(mappings.motionMap)) {
    if (!VOCABULARY_NAME.test(word) || !motionNames.has(`${target.group}:${target.index}`)) {
      throw new CharacterResourceValidationError('live2d_mapping_target_invalid');
    }
  }
}
