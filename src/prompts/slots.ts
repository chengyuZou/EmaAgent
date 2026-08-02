// 集中声明 Prompt Slot 的身份、顺序、稳定范围、投递方式与信任级别。
import type {
  PromptSlot,
  PromptSlotId,
  PromptStabilityScope,
} from './types.js';

export type PromptSlotSpec = Pick<
  PromptSlot,
  'order' | 'stabilityScope' | 'delivery' 
>;

export const PROMPT_SLOT_SPECS: Readonly<Record<string, PromptSlotSpec>> = Object.freeze({
  'product.rules': Object.freeze({
    order: 10, stabilityScope: 'product', delivery: 'system'
  }),
  'product.toolGuidance': Object.freeze({
    order: 20, stabilityScope: 'product', delivery: 'system'
  }),
  'extension.skillCatalog': Object.freeze({
    order: 40, stabilityScope: 'turn', delivery: 'context'
  }),
  // 工作区规则(Codex/Claude 兼容或 Ema 原生),同一工作区跨 Turn 复用同一快照。
  'workspace.instructions': Object.freeze({
    order: 50, stabilityScope: 'session', delivery: 'context'
  }),
  'character.identity': Object.freeze({
    order: 60, stabilityScope: 'activeCharacter', delivery: 'system'
  }),
  'character.presentation': Object.freeze({
    order: 70, stabilityScope: 'activeCharacter', delivery: 'system'
  }),
  'profile.execution': Object.freeze({
    order: 80, stabilityScope: 'turn', delivery: 'system'
  }),
});

/**
 * 参数化槽:skillId 运行时才有,按前缀继承同一份 spec。
 * skills.required.* 只装 Ema 自带常驻 Skill 全文,随产品稳定;
 * skills.active.* 装本轮激活 Skill 全文,生命周期不越过当前根 Turn。
 */
const PROMPT_SLOT_PREFIX_SPECS: readonly { prefix: string; spec: PromptSlotSpec }[] = Object.freeze([
  Object.freeze({
    prefix: 'skills.required.',
    spec: Object.freeze({
      order: 35, stabilityScope: 'product', delivery: 'system',
    }),
  }),
  Object.freeze({
    prefix: 'skills.active.',
    spec: Object.freeze({
      order: 55, stabilityScope: 'turn', delivery: 'context',
    }),
  }),
]);

/** 先精确匹配,再按前缀继承;空前缀后缀(如 skills.required.)与未知槽一律拒绝。 */
export function slotSpecFor(id: PromptSlotId): PromptSlotSpec | undefined {
  const exact = PROMPT_SLOT_SPECS[id];
  if (exact) return exact;
  for (const { prefix, spec } of PROMPT_SLOT_PREFIX_SPECS) {
    if (id.startsWith(prefix) && id.length > prefix.length) return spec;
  }
  return undefined;
}

export const PROMPT_STABILITY_ORDER: readonly PromptStabilityScope[] = Object.freeze([
  'product',
  'activeCharacter',
  'session',
  'turn',
]);
