import type { GithubMarketSource, SkillMarket } from './types.js';
import { GithubSkillMarket } from './github-market.js';

// ── ad-hoc:为任意 GitHub repo 构建一次性 market(不注册)──────────────────────
//
// 路由 ?owner=&repo=&ref= 用:不写 DB,直接列 SKILL.md。

export function marketFromGithub(source: GithubMarketSource): SkillMarket {
  return new GithubSkillMarket(
    `github:${source.owner}/${source.repo}`,
    `${source.owner}/${source.repo}`,
    source,
  );
}
