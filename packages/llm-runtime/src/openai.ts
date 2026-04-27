/**
 * 兼容旧导入路径。
 *
 * 历史代码可能从 `@ema-agent/llm-runtime/openai` 或源码 `./openai.js`
 * 引入 OpenAIProvider。真实实现已经迁移到 adapters/openai-native.ts。
 */

export { OpenAINativeProvider, OpenAIProvider } from "./adapters/openai-native.js";
export type { OpenAINativeProviderConfig } from "./adapters/openai-native.js";
