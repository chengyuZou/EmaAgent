// 这里把 Skill 各类市场源注册为 Marketplace 可以统一调度的 Adapter.
import type { MarketSourceAdapter, MarketSourceRecord, MarketSourceTypeSchema } from '@ema-agent/marketplace';
import type { MarketSkillEntry } from '../types.js';
import { SKILL_TYPE_HANDLERS, SKILL_SUPPORTED_TYPES } from './handlers/index.js';

// ── Skill market adapter(kind='skill')─────────────────────────────────────────
//
// 总 dispatch:查 handlers/ 的 type→handler Map,转发 list / validateConfig / describeTypes。
// 加新 source type = 加 handlers/<type>.ts + handlers/index.ts 注册一行,
// 此文件零改动。底座只见 MarketSourceAdapter 接口,不感知 type 细节。

export class SkillMarketAdapter implements MarketSourceAdapter<MarketSkillEntry> {
  readonly kind  = 'skill';
  readonly types = SKILL_SUPPORTED_TYPES;

  async list(source: MarketSourceRecord, signal?: AbortSignal): Promise<MarketSkillEntry[]> {
    const handler = SKILL_TYPE_HANDLERS[source.type];
    if (!handler) throw new Error(`Unsupported skill market source type: ${source.type}`);
    return handler.list(source, signal);
  }

  validateConfig(type: string, config: unknown): { ok: true; config: string } | { ok: false; error: string } {
    const handler = SKILL_TYPE_HANDLERS[type];
    if (!handler) return { ok: false, error: `不支持的 skill 源 type: ${type}` };
    return handler.validateConfig(config);
  }

  describeTypes(): readonly MarketSourceTypeSchema[] {
    return Object.values(SKILL_TYPE_HANDLERS).map((h) => h.schema);
  }
}
