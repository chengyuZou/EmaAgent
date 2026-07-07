import { fetchGithubTree } from '@ema-agent/marketplace';
import type { MarketSourceRecord } from '@ema-agent/marketplace';
import type { MarketSkillEntry } from '../../types.js';
import type { GithubSkillSourceConfig } from '../types.js';

// ── github source type ────────────────────────────────────────────────────────
//
// GitHub 仓库,git tree API 一次拿全文件列表,filter SKILL.md,构建条目。
// mirrorUrl 提供时,条目 url 用 mirror base 拼接(jsDelivr CN 可达);否则用 raw.githubusercontent。

/** 从 market_sources 行解析 config 并列出可装 skill。 */
export async function list(source: MarketSourceRecord): Promise<MarketSkillEntry[]> {
  const cfg = JSON.parse(source.config) as GithubSkillSourceConfig;
  if (!cfg.owner || !cfg.repo || !cfg.ref) {
    throw new Error('github skill source missing owner/repo/ref');
  }
  // api.github.com 不被 CDN 代理,失败就抛错;条目 url 用 mirrorUrl 拼(CN 可达)
  const tree = await fetchGithubTree(cfg.owner, cfg.repo, cfg.ref);

  const entries: MarketSkillEntry[] = [];
  for (const node of tree) {
    if (node.type !== 'blob') continue;
    const lower = node.path.toLowerCase();
    if (lower !== 'skill.md' && !lower.endsWith('/skill.md')) continue;

    const dir  = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
    const name = dir ? dir.slice(dir.lastIndexOf('/') + 1) : cfg.repo;
    const url  = cfg.mirrorUrl
      ? `${cfg.mirrorUrl.replace(/\/$/, '')}/${node.path}`
      : `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.ref}/${node.path}`;
    entries.push({ name, path: dir, url });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/** 校验 github config,返回标准化 JSON。 */
export function validateConfig(config: unknown): { ok: true; config: string } | { ok: false; error: string } {
  if (!isObj(config)) return fail('config 必须是对象');
  const { owner, repo, ref } = config as { owner?: unknown; repo?: unknown; ref?: unknown };
  if (typeof owner !== 'string' || !owner) return fail('owner 必须是非空字符串');
  if (typeof repo !== 'string' || !repo) return fail('repo 必须是非空字符串');
  if (typeof ref !== 'string' || !ref) return fail('ref 必须是非空字符串');
  const mirrorUrl = (config as { mirrorUrl?: unknown }).mirrorUrl;
  if (mirrorUrl !== undefined && (typeof mirrorUrl !== 'string' || !mirrorUrl.startsWith('http'))) {
    return fail('mirrorUrl 必须是 http(s) URL');
  }
  const cfg: GithubSkillSourceConfig = { owner, repo, ref, ...(typeof mirrorUrl === 'string' ? { mirrorUrl } : {}) };
  return ok(JSON.stringify(cfg));
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function ok(config: string): { ok: true; config: string } { return { ok: true, config }; }
function fail(error: string): { ok: false; error: string } { return { ok: false, error }; }
