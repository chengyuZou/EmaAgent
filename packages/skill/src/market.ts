import type { MarketSkillEntry } from './types.js';

// ── Skill marketplace ───────────────────────────────────────────────────────────
//
// We don't host an index. A "market" is just a GitHub repo whose folders each
// contain a SKILL.md. We discover them with the git-tree API (one request,
// recursive) and build raw-content URLs the installer can fetch. The default
// source is the official Anthropic skills repo; users can point at any repo.

export interface MarketSource {
  owner: string;
  repo:  string;
  ref:   string;   // branch or tag
}

export const DEFAULT_MARKET: MarketSource = {
  owner: 'anthropics',
  repo:  'skills',
  ref:   'main',
};

interface GitTreeResponse {
  tree?: Array<{ path: string; type: string }>;
}

/**
 * List installable skills in a GitHub repo by finding every `**​/SKILL.md`.
 * One request via the recursive git-tree API; no per-skill fetch.
 */
export async function listMarketSkills(source: MarketSource = DEFAULT_MARKET): Promise<MarketSkillEntry[]> {
  const { owner, repo, ref } = source;
  const api = `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;

  const res = await fetch(api, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ema-agent' },
    signal:  AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to list market skills from ${owner}/${repo}@${ref}: HTTP ${res.status}`);
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
      skillMdUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${node.path}`,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}
