export { buildModelMessages } from './messageBuilder.js';
export { computePromptPrefixHash, normalizeToolDefinitions } from './promptPrefix.js';
export {
  prepareHistoricalMessageView,
  validateCurrentContent,
} from './messageCompatibility.js';
export type {
  CompatibleMessageView,
  InputModality,
  MessageCompatibilityAction,
  MessageCompatibilityIssue,
} from './messageCompatibility.js';
