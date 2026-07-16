// 这是 Conversation 包的统一出口，外部代码从这里使用聊天/叙事引擎和它的 hook 注册。

export { ConversationEngine } from './engine.js';
export { registerConversationHooks } from './hooks.js';
export type { ConversationDeps, ConversationRunInput } from './types.js';
