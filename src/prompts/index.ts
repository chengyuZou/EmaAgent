// 这是 Prompts 包的统一出口，外部代码从这里组装 system prompt 和注册它的 hook。

export { buildSystemPrompt, buildSystemBlock } from './build.js';
export { buildModeBlock } from './mode-blocks.js';
export { PromptAssembler } from './promptAssembler.js';
export { PromptAssemblyError } from './errors.js';
export type { BuildSystemPromptOpts } from './build.js';
export type { ModeBlockOpts } from './mode-blocks.js';
export type {
  PromptCacheScope,
  PromptSlot,
  PromptSlotContribution,
  PromptSlotId,
  PromptSlotKind,
  PromptSnapshot,
  PromptTrust,
} from './types.js';
export type { PromptAssemblyErrorCode } from './errors.js';

export { registerPromptsHooks } from './hooks.js';
export type { PromptsHooksDeps } from './hooks.js';
