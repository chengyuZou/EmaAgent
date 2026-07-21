// Conversation 模块统一导出聊天执行与 Narrative 召回能力。

export { ConversationEngine } from './engine.js';
export { prepareNarrativeContribution } from './narrativeRecall.js';
export type { NarrativeRecallContext } from './narrativeRecall.js';
export type { ConversationDeps, ConversationRunInput } from './types.js';
