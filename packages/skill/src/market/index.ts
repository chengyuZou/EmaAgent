// ── Skill market 公共导出 ─────────────────────────────────────────────────────
//
// 注册型 market 走 @ema-agent/marketplace 底座 + SkillMarketAdapter。
// 这里导出 adapter + seeds 供 wiring 注册,以及 ad-hoc 工具供路由 ?owner=&repo=&ref= 用。

export { SkillMarketAdapter } from './adapter.js';
export { SKILL_SEEDS } from './seeds/index.js';
export { listGithubSkillSource, GithubSkillMarket } from './github-market.js';
export { listGithubSkillsAdhoc as listGithubSkills } from './github-market.js';
export { listJsonIndexSource } from './json-index.js';
export { marketFromGithub } from './ad-hoc.js';
export type {
  SkillMarket,
  GithubMarketSource,
  GithubSkillSourceConfig,
  SkillJsonIndexConfig,
  SkillJsonIndexEntry,
  SkillJsonIndex,
} from './types.js';
