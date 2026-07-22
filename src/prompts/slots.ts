// 集中声明 Prompt Slot 的身份、顺序、稳定范围、投递方式与信任级别。
import type {
  PromptSlot,
  PromptSlotId,
  PromptStabilityScope,
} from './types.js';

export type PromptSlotSpec = Pick<
  PromptSlot,
  'kind' | 'order' | 'stabilityScope' | 'delivery' | 'trust'
>;

export const PROMPT_SLOT_SPECS: Readonly<Record<PromptSlotId, PromptSlotSpec>> = Object.freeze({
  'product.rules': Object.freeze({
    kind: 'rules', order: 10, stabilityScope: 'product', delivery: 'system', trust: 'product',
  }),
  'product.toolGuidance': Object.freeze({
    kind: 'guidance', order: 20, stabilityScope: 'product', delivery: 'system', trust: 'product',
  }),
  'extension.skillCatalog': Object.freeze({
    kind: 'extension', order: 40, stabilityScope: 'turn', delivery: 'context', trust: 'extension',
  }),
  'character.identity': Object.freeze({
    kind: 'identity', order: 60, stabilityScope: 'activeCharacter', delivery: 'system', trust: 'user-configured',
  }),
  'character.presentation': Object.freeze({
    kind: 'presentation', order: 70, stabilityScope: 'activeCharacter', delivery: 'system', trust: 'user-configured',
  }),
  'profile.execution': Object.freeze({
    kind: 'execution', order: 80, stabilityScope: 'turn', delivery: 'system', trust: 'product',
  }),
});

export const PROMPT_STABILITY_ORDER: readonly PromptStabilityScope[] = Object.freeze([
  'product',
  'activeCharacter',
  'turn',
]);
