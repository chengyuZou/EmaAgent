import type { MarketSourceSeed } from '@ema-agent/marketplace';

// ── Anthropic 官方 skills 源 ──────────────────────────────────────────────────
//
// github.com/anthropics/skills,git tree API 找所有 SKILL.md。
// mirrorUrl 走 jsDelivr CDN(CN 可达)—— raw.githubusercontent.com 在 CN 常被墙,
// GithubSkillMarket.list() / installer 均支持 mirror 降级。

export const ANTHROPIC_SKILLS_SEED: MarketSourceSeed = {
  id:        'anthropic-skills',
  kind:      'skill',
  type:      'github',
  label:     'Anthropic 官方技能',
  config:    JSON.stringify({
    owner:     'anthropics',
    repo:      'skills',
    ref:       'main',
    mirrorUrl: 'https://cdn.jsdelivr.net/gh/anthropics/skills@main/',
  }),
  sortOrder: 0,
};
