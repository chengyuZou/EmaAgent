import type { MarketSkillEntry } from '../types.js';

// ── Skill market 抽象(保留:ad-hoc 用)─────────────────────────────────────────
//
// 注册型 market 已交给 @ema-agent/marketplace 底座 + SkillMarketAdapter。
// 这里保留 SkillMarket 接口供 marketFromGithub() ad-hoc 用(路由 ?owner=&repo=&ref=)。

export interface SkillMarket {
  /** Stable id, e.g. 'anthropic'. */
  id:    string;
  /** Human-facing label. */
  label: string;
  /** Enumerate installable skills. */
  list(): Promise<MarketSkillEntry[]>;
}

// ── 各 source type 的 config 结构(存 market_sources.config JSON)───────────────

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

// ── 旧 ad-hoc 用(保留兼容 marketFromGithub)──────────────────────────────────

export interface GithubMarketSource {
  owner: string;
  repo:  string;
  ref:   string;   // branch or tag
}
