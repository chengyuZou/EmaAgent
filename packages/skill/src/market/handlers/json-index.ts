import { fetchJson } from '@ema-agent/marketplace';
import type { MarketSourceRecord } from '@ema-agent/marketplace';
import type { MarketSkillEntry } from '../../types.js';
import type { SkillJsonIndex, SkillJsonIndexConfig } from '../types.js';

// ── json-index source type ────────────────────────────────────────────────────
//
// 通用 JSON 索引源(用户自传 URL)。约定 JSON 格式:{ entries: [{ name, path?, url }] }
// 用户可自 host 一个 skill 列表,或镜像官方列表。url 字段是 SKILL.md 直链。

/** 列出某 json-index 源的所有可装 skill。 */
export async function list(source: MarketSourceRecord): Promise<MarketSkillEntry[]> {
  const cfg = JSON.parse(source.config) as SkillJsonIndexConfig;
  if (!cfg.indexUrl) throw new Error('json-index source missing indexUrl');

  const data = await fetchJson<SkillJsonIndex>(cfg.indexUrl, cfg.mirrorUrl, {
    timeoutMs: 10_000,
    headers:   { Accept: 'application/json' },
  });

  const entries = (data?.entries ?? [])
    .filter((e) => e && typeof e.name === 'string' && typeof e.url === 'string')
    .map((e): MarketSkillEntry => ({
      name: e.name,
      path: e.path ?? '',
      url:  e.url,
    }));

  // 按 name 去重,留最后一条
  const map = new Map<string, MarketSkillEntry>();
  for (const e of entries) map.set(e.name, e);
  return [...map.values()];
}

/** 校验 json-index config,返回标准化 JSON。 */
export function validateConfig(config: unknown): { ok: true; config: string } | { ok: false; error: string } {
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

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function ok(config: string): { ok: true; config: string } { return { ok: true, config }; }
function fail(error: string): { ok: false; error: string } { return { ok: false, error }; }
