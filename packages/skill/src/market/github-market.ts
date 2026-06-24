import type { MarketSkillEntry } from '../types.js';
import type { GithubMarketSource, SkillMarket } from './types.js';

interface GitTreeResponse {
  tree?: Array<{ path: string; type: string }>;
}

// ── Generic GitHub-repo skill market ──────────────────────────────────────────
//
// Discovers every `**​/SKILL.md` in a repo with the recursive git-tree API
// (one request) and builds raw-content URLs the installer can fetch. Reusable
// for ANY repo following the "folder-with-SKILL.md" convention; the Anthropic
// default is just one instance (see anthropic-market.ts).

export class GithubSkillMarket implements SkillMarket {
  constructor(
    readonly id: string,
    readonly label: string,
    private readonly source: GithubMarketSource,
  ) {}

  async list(): Promise<MarketSkillEntry[]> {
    const { owner, repo, ref } = this.source;
    const api = `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;

    const res = await fetch(api, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ema-agent' },
      signal:  AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`Failed to list skills from ${owner}/${repo}@${ref}: HTTP ${res.status}`);
    }

    const data = (await res.json()) as GitTreeResponse;
    const entries: MarketSkillEntry[] = [];
    for (const node of data.tree ?? []) {
      if (node.type !== 'blob') continue;
      const lower = node.path.toLowerCase();
      if (lower !== 'skill.md' && !lower.endsWith('/skill.md')) continue;

      const dir  = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
      const name = dir ? dir.slice(dir.lastIndexOf('/') + 1) : repo;
      entries.push({
        name,
        path: dir,
        url: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${node.path}`,
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }
}
