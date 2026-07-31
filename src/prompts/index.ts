// 统一导出 Prompt 快照组装、槽位类型和稳定产品指令。

export { buildPromptSnapshot } from './promptBuilder.js';
export { buildExecutionProfileContribution } from './executionProfilePrompt.js';
export { PromptAssembler } from './promptAssembler.js';
export { PromptAssemblyError } from './errors.js';
export { buildProductPromptContributions } from './productPrompt.js';
export { PROMPT_SLOT_SPECS, PROMPT_STABILITY_ORDER, slotSpecFor } from './slots.js';
export type {
  PromptBuildRequest,
  PromptBlock,
  PromptSlot,
  PromptSlotContribution,
  PromptDelivery,
  PromptSlotId,
  PromptStabilityScope,
  PromptSnapshot,
  PromptRevisions
} from './types.js';
export type { PromptAssemblyErrorCode } from './errors.js';
export type { PromptSlotSpec } from './slots.js';
