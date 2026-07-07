import type { MarketSkillEntry } from '../types.js';

// ── 各 source type 的 config 结构(存 market_sources.config JSON)───────────────
//
// 注册型 market 走 @ema-agent/marketplace 底座 + SkillMarketAdapter。
// adapter.list(source) 从 source.config 解析出坐标/URL 去 fetch。
// 这里只定义 config 形状,不定义 SkillMarket 抽象(底座已有 MarketSourceAdapter)。

/** type='github':GitHub 仓库,git tree API 找所有 SKILL.md */
export interface GithubSkillSourceConfig {
  owner:     string;
  repo:      string;
  ref:       string;
  /** jsDelivr 等 CDN base,如 https://cdn.jsdelivr.net/gh/owner/repo@ref/ —— CN 可达 */
  mirrorUrl?: string;
}

/** type='json-index':用户自传 JSON 索引 URL */
export interface SkillJsonIndexConfig {
  indexUrl:   string;
  mirrorUrl?: string;
}

// ── 通用 JSON 索引条目(json-index type 解析这个)──────────────────────────────
//
// 约定格式:{ entries: SkillJsonIndexEntry[] }

export interface SkillJsonIndexEntry {
  name:        string;
  path?:       string;
  url:         string;
}

export interface SkillJsonIndex {
  entries: SkillJsonIndexEntry[];
}

// MarketSkillEntry 从 ../types.js 重导出,方便 handlers 一次性 import
export type { MarketSkillEntry };
