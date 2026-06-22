// ── @ema-agent/token — heuristic token counting & budgeting ──────────────────
//
// Pure functions, zero runtime deps. Shared by:
//   - memory   (compaction trigger / context budget)
//   - desktop-ui (streaming "~N tok" estimate before the authoritative usage
//     event arrives — estimate-then-correct pattern)

export { estimateTextTokens, estimateMessagesTokens } from './estimate.js';

// Model context windows + embedding dims used to live here as static JSON tables.
// Removed: context now comes from the models.dev catalog (@ema-agent/llm
// ModelsDevCatalog) and embedding dim is probed at enable time (EmbedResponse.dim
// → provider_embed_models.dim, dim_source='live'). See docs §Z.5.
