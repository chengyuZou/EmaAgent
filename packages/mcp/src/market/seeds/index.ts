// ── MCP builtin market seeds 聚合 ─────────────────────────────────────────────
//
// 启动时由 MarketSourceStore.ensureSeeds() 幂等写入。加新 builtin 源 = 加一个
// 文件 + 在此数组追加。用户对 builtin 源的启停/排序不会被覆盖(只检查 id 存在性)。

import type { MarketSourceSeed } from '@ema-agent/marketplace';
import { OFFICIAL_REGISTRY_SEED } from './official-registry.js';

export const MCP_SEEDS: MarketSourceSeed[] = [
  OFFICIAL_REGISTRY_SEED,
];
