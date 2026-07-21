// 把旧 TurnMode 投影为迁移期 Profile 槽，避免兼容语义散落在 Prompt 主装配器。

import type { TurnMode } from '@ema-agent/contracts';
import { buildModeBlock, type ModeBlockOpts } from './mode-blocks.js';
import type { PromptSlotContribution } from './types.js';

export function buildLegacyExecutionProfileContribution(
  mode: TurnMode,
  options: ModeBlockOpts = {},
): PromptSlotContribution {
  return {
    id: 'profile.execution',
    content: buildModeBlock(mode, options),
    version: `legacy-turn-mode:${mode}`,
  };
}
