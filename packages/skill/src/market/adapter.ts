import type { MarketSourceAdapter } from '@ema-agent/marketplace';
import type { MarketSourceRecord } from '@ema-agent/marketplace';
import type { MarketSkillEntry } from '../types.js';
import { SKILL_TYPE_HANDLERS, SKILL_SUPPORTED_TYPES } from './adapters/index.js';

// ── Skill market adapter(kind='skill')─────────────────────────────────────────
//
// 总 dispatch:查 adapters/ 的 type→handler Map,转发 list / validateConfig。
// 加新 source type = 加 adapters/<type>.ts + adapters/index.ts 注册一行,
// 此文件零改动。底座只见 MarketSourceAdapter 接口,不感知 type 细节。

export class SkillMarketAdapter implements MarketSourceAdapter<MarketSkillEntry> {
  readonly kind  = 'skill';
  readonly types = SKILL_SUPPORTED_TYPES;

  async list(source: MarketSourceRecord): Promise<MarketSkillEntry[]> {
    const handler = SKILL_TYPE_HANDLERS[source.type];
    if (!handler) throw new Error(`Unsupported skill market source type: ${source.type}`);
    return handler.list(source);
  }

  validateConfig(type: string, config: unknown): { ok: true; config: string } | { ok: false; error: string } {
    const handler = SKILL_TYPE_HANDLERS[type];
    if (!handler) return { ok: false, error: `不支持的 skill 源 type: ${type}` };
    return handler.validateConfig(config);
  }
}
