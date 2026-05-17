// Re-export from the conversation package so existing imports keep working.
// The real implementation lives in packages/conversation.
export { ConversationEngine } from '@ema-agent/conversation';
export type { ConversationDeps, ConversationRunInput } from '@ema-agent/conversation';
