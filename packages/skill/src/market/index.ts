// ── Skill market 公共导出 ─────────────────────────────────────────────────────
//
// 注册型 market 走 @ema-agent/marketplace 底座 + SkillMarketAdapter(总 dispatch)
// + adapters/<type>.ts(各 type 的 list/validate 实现)。
// 所有源进 DB(market_sources 表),无 ad-hoc 入口 —— 与 mcp 对称。

export { SkillMarketAdapter } from './adapter.js';
export { SKILL_SEEDS } from './seeds/index.js';
// 各 type handler 的 list 也导出(供测试 / 路由直接调单源)
export { list as listGithubSource, validateConfig as validateGithubConfig } from './adapters/github.js';
export { list as listJsonIndexSource, validateConfig as validateJsonIndexConfig } from './adapters/json-index.js';
export type { SkillSourceTypeHandler } from './adapters/index.js';
export type {
  GithubSkillSourceConfig,
  SkillJsonIndexConfig,
  SkillJsonIndexEntry,
  SkillJsonIndex,
} from './types.js';
