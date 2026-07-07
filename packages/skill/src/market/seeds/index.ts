// ── Skill builtin market seeds 聚合 ───────────────────────────────────────────
//
// 启动时由 MarketSourceStore.ensureSeeds() 幂等写入。加新 builtin 源 = 加一个
// 文件 + 在此数组追加。

import type { MarketSourceSeed } from '@ema-agent/marketplace';
import { ANTHROPIC_SKILLS_SEED } from './anthropic.js';

export const SKILL_SEEDS: MarketSourceSeed[] = [
  ANTHROPIC_SKILLS_SEED,
];
