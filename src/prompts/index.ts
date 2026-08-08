// 统一导出 System Prompt 装配入口与边界哨兵。
export { getSystemPrompt, PROMPT_DYNAMIC_BOUNDARY } from './systemPrompt.js';
export type { GetSystemPromptInput } from './systemPrompt.js';
export { productRules, toolUsageGuidance } from './productPrompt.js';
export { executionProfileInstructions } from './executionProfilePrompt.js';
