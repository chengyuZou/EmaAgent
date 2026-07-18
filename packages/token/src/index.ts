// ── @ema-agent/token — heuristic token counting & budgeting ──────────────────
//
// Pure functions, zero runtime deps. Shared by:
//   - memory   (compaction trigger / context budget)
//   - desktop-ui (streaming "~N tok" estimate before the authoritative usage
//     event arrives — estimate-then-correct pattern)

export {
  estimateTextTokens,
  estimateMessagesTokens,
  estimateLlmInputTokens,
} from './estimate.js';
export type {
  TokenEstimate,
  TokenEstimateAccuracy,
  TokenEstimateBreakdown,
  TokenEstimateOptions,
  TokenEstimateWarningCode,
  TokenToolDefinition,
} from './types.js';
