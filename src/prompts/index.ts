// 这是 Prompts 包的统一出口，外部代码从这里组装 system prompt 和注册它的 hook。

export { buildSystemPrompt, buildSystemBlock } from './build.js';
export { buildModeBlock } from './mode-blocks.js';
export type { BuildSystemPromptOpts } from './build.js';
export type { ModeBlockOpts } from './mode-blocks.js';

export { registerPromptsHooks } from './hooks.js';
export type { PromptsHooksDeps } from './hooks.js';
