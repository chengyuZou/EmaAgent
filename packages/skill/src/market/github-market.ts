import { fetchGithubTree } from '@ema-agent/marketplace';
import type { MarketSourceRecord } from '@ema-agent/marketplace';
import type { MarketSkillEntry } from '../types.js';
import type { GithubSkillSourceConfig, GithubMarketSource, SkillMarket } from './types.js';

// ── 通用 GitHub-repo skill 列表 ────────────────────────────────────────────────
//
// 用 git tree API 一次拿全文件列表,filter SKILL.md,构建条目。
// mirrorUrl 提供时,条目 url 用 mirror base 拼接(jsDelivr CN 可达);否则用 raw.githubusercontent。
// 复用 marketplace 底座的 fetchGithubTree,不自己写 fetch。

/** 从 market_sources 行解析 config 并列出可装 skill。 */
export async function listGithubSkillSource(source: MarketSourceRecord): Promise<MarketSkillEntry[]> {
  const cfg = JSON.parse(source.config) as GithubSkillSourceConfig;
  if (!cfg.owner || !cfg.repo || !cfg.ref) {
    throw new Error('github skill source missing owner/repo/ref');
  }
  return listGithubSkills(cfg, cfg.mirrorUrl);
}

/** ad-hoc:从 owner/repo/ref 列出(路由 ?owner=&repo=&ref= 用)。 */
export async function listGithubSkillsAdhoc(source: GithubMarketSource): Promise<MarketSkillEntry[]> {
  return listGithubSkills(source);
}

async function listGithubSkills(
  coords: { owner: string; repo: string; ref: string },
  mirrorUrl?: string,
): Promise<MarketSkillEntry[]> {
  const { owner, repo, ref } = coords;
  const tree = await fetchGithubTree(owner, repo, ref, undefined);

  const entries: MarketSkillEntry[] = [];
  for (const node of tree) {
    if (node.type !== 'blob') continue;
    const lower = node.path.toLowerCase();
    if (lower !== 'skill.md' && !lower.endsWith('/skill.md')) continue;

    const dir  = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
    const name = dir ? dir.slice(dir.lastIndexOf('/') + 1) : repo;
    const url  = mirrorUrl
      ? `${mirrorUrl.replace(/\/$/, '')}/${node.path}`
      : `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${node.path}`;
    entries.push({ name, path: dir, url });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

// ── GithubSkillMarket 类(ad-hoc marketFromGithub 用,保留兼容)──────────────────

export class GithubSkillMarket implements SkillMarket {
  constructor(
    readonly id:    string,
    readonly label: string,
    private readonly source: GithubMarketSource,
  ) {}

  async list(): Promise<MarketSkillEntry[]> {
    return listGithubSkillsAdhoc(this.source);
  }
}
