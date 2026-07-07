import type { MarketSourceRecord } from '@ema-agent/marketplace';
import type { MarketSkillEntry } from '../../types.js';
import * as github from './github.js';
import * as jsonIndex from './json-index.js';

// ── adapters 聚合(type → { list, validateConfig } 映射)─────────────────────────
//
// 业务包内部约定:每个 source type 一个 adapters/<type>.ts,导出 list + validateConfig。
// 此文件聚合 Map,adapter.ts 查表 dispatch。加新 type = 加一个文件 + 在此注册。

export interface SkillSourceTypeHandler {
  list:           (source: MarketSourceRecord) => Promise<MarketSkillEntry[]>;
  validateConfig: (config: unknown) => { ok: true; config: string } | { ok: false; error: string };
}

export const SKILL_TYPE_HANDLERS: Record<string, SkillSourceTypeHandler> = {
  'github':     github,
  'json-index': jsonIndex,
};

/** 该 kind 支持的所有 source type(供 adapter.ts 暴露给底座)。 */
export const SKILL_SUPPORTED_TYPES = Object.keys(SKILL_TYPE_HANDLERS);
