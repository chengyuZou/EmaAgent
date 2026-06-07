/**
 * Compatibility re-exports.
 *
 * New code should import from session-store or conversation-store directly.
 * This file exists so existing imports continue to resolve while the migration
 * to the split stores is completed incrementally.
 */
export { useSessionStore }     from './session-store.js';
export type { SessionStoreState, SessionsState } from './session-store.js';

export { useConversationStore } from './conversation-store.js';
export type {
  ConversationStoreState,
  AssistantSlice,
  StreamingAssistantMessage,
  ChatHistoryItem,
} from './conversation-store.js';
