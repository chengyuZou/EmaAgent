// 这里汇总所有内置角色卡种子，启动时 sidecar 遍历它幂等注册。

/**
 * 内置角色卡种子。
 *
 * 每个内置角色一个文件。新增内置角色：
 *   1. 在这里建 `<id>-seed.ts`，导出一个 `CharacterCardInput`
 *   2. 把角色资源放进 `apps/desktop/public/cards/<id>/`
 *      （live2d/ + voiceRefs/ + live2d/runtime-config.json）
 *   3. 把种子 push 进下面的 BUILTIN_CARDS
 *
 * sidecar 启动时自动注册 BUILTIN_CARDS 里每条（幂等--已在 DB 的跳过）。
 * 没有死代码：新角色就是数据 + 一次 push，无需改接线。
 */
import type { CharacterCardInput } from '../types.js';
import { EMA_CARD_INPUT, EMA_CARD_ID } from './ema-seed.js';

export { EMA_CARD_INPUT, EMA_CARD_ID };

/**
 * 所有内置角色卡。启动 seeder 遍历此列表，逐条 upsert 进
 * character_cards + live2d_models（is_builtin=1）。
 */
export const BUILTIN_CARDS: CharacterCardInput[] = [
  EMA_CARD_INPUT,
  // 未来的内置角色放这里--push 种子即可。
];
