import { fetchJson } from '@ema-agent/marketplace';
import type { MarketSourceRecord } from '@ema-agent/marketplace';
import type { MarketSkillEntry } from '../types.js';
import type { SkillJsonIndex, SkillJsonIndexConfig } from './types.js';

// ── 通用 JSON 索引源(用户自传 URL)──────────────────────────────────────────────
//
// 约定 JSON 格式:{ entries: [{ name, path?, url }] }
// 用户可自 host 一个 skill 列表,或镜像官方列表。url 字段是 SKILL.md 直链。

/** 列出某 json-index 源的所有可装 skill。 */
export async function listJsonIndexSource(source: MarketSourceRecord): Promise<MarketSkillEntry[]> {
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
