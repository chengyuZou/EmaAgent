import type { MarketSourceAdapter } from '@ema-agent/marketplace';
import type { MarketSourceRecord } from '@ema-agent/marketplace';
import type { MarketSkillEntry } from '../types.js';
import type { GithubSkillSourceConfig, SkillJsonIndexConfig } from './types.js';
import { listGithubSkillSource } from './github-market.js';
import { listJsonIndexSource } from './json-index.js';

// ── Skill market adapter(kind='skill')─────────────────────────────────────────
//
// 支持 type:
//   - 'github':    GitHub 仓库,git tree API 找 SKILL.md(config: { owner, repo, ref, mirrorUrl? })
//   - 'json-index':用户自传 JSON 索引(config: { indexUrl, mirrorUrl? })
// 新 type = 加一个 list*.ts + 在此 switch。

export class SkillMarketAdapter implements MarketSourceAdapter<MarketSkillEntry> {
  readonly kind  = 'skill';
  readonly types = ['github', 'json-index'] as const;

  async list(source: MarketSourceRecord): Promise<MarketSkillEntry[]> {
    switch (source.type) {
      case 'github':     return listGithubSkillSource(source);
      case 'json-index': return listJsonIndexSource(source);
      default:
        throw new Error(`Unsupported skill market source type: ${source.type}`);
    }
  }

  validateConfig(type: string, config: unknown): { ok: true; config: string } | { ok: false; error: string } {
    if (type === 'github') {
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

    if (type === 'json-index') {
      if (!isObj(config)) return fail('config 必须是对象');
      const indexUrl = (config as { indexUrl?: unknown }).indexUrl;
      if (typeof indexUrl !== 'string' || !indexUrl.startsWith('http')) return fail('indexUrl 必须是 http(s) URL');
      const mirrorUrl = (config as { mirrorUrl?: unknown }).mirrorUrl;
      if (mirrorUrl !== undefined && (typeof mirrorUrl !== 'string' || !mirrorUrl.startsWith('http'))) {
        return fail('mirrorUrl 必须是 http(s) URL');
      }
      const cfg: SkillJsonIndexConfig = { indexUrl, ...(typeof mirrorUrl === 'string' ? { mirrorUrl } : {}) };
      return ok(JSON.stringify(cfg));
    }

    return fail(`不支持的 skill 源 type: ${type}`);
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function ok(config: string): { ok: true; config: string } { return { ok: true, config }; }
function fail(error: string): { ok: false; error: string } { return { ok: false, error }; }
