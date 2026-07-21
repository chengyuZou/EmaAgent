// 为旧 Engine 组装兼容 System Prompt，新主链应直接消费 PromptSnapshot。

import type { TurnMode } from '@ema-agent/contracts';
import {
  buildCharacterPromptSections,
  type CharacterCard,
} from '@ema-agent/characters';
import { buildLegacyExecutionProfileContribution } from './legacyExecutionProfile.js';
import { PromptAssembler } from './promptAssembler.js';
import { buildProductPromptContributions } from './productPrompt.js';
import type { PromptSlotContribution, PromptSnapshot } from './types.js';

const assembler = new PromptAssembler();

export interface BuildSystemPromptOpts {
  /** Agent 允许操作的工作区根目录绝对路径。null/undefined = 未设置。 */
  workspaceRoot?: string | null;
}

/**
 * 组装一次 turn 的完整 system prompt。
 *
 * 结构：
 *   - 角色块--人设 + ACT 标签词汇（来自 character-card）
 *   - 模式块--chat / narrative / agent 的行为约束
 *
 * 注意：memory 召回不在这里注入。按架构，RecallBundle 由 orchestrator 作为
 * 独立的 `user` 角色 context message 追加，这样 system 前缀保持稳定，能吃 prompt 缓存。
 */
export function buildSystemPrompt(
  card: CharacterCard,
  mode: TurnMode,
  opts: BuildSystemPromptOpts = {},
): string {
  return buildPromptSnapshot(card, mode, opts).systemText;
}

/** 新 Context 主链消费完整快照，避免把 Prompt 版本和缓存边界压扁成裸字符串。 */
export function buildPromptSnapshot(
  card: CharacterCard,
  mode: TurnMode,
  opts: BuildSystemPromptOpts = {},
): PromptSnapshot {
  const productSlots = buildProductPromptContributions();
  const characterSlots = buildCharacterSlots(card);
  const profileSlot = buildLegacyExecutionProfileContribution(mode, {
    workspaceRoot: opts.workspaceRoot,
  });

  return assembler.build([...productSlots, ...characterSlots, profileSlot]);
}

// ── 角色块（从 character-card/system-block.ts 迁来）────────────────────────────

/**
 * 组装角色卡的 system-prompt 块：
 *   1. 卡片的原始 systemPrompt（人设文本）
 *   2. ACT 内联标签协议说明，按本卡的词汇表限定
 */
export function buildSystemBlock(card: CharacterCard): string {
  return assembler.build(buildCharacterSlots(card)).systemText;
}

function buildCharacterSlots(card: CharacterCard): PromptSlotContribution[] {
  const sections = buildCharacterPromptSections(card);
  return [
    {
      id: 'character.identity',
      content: sections.identity,
      version: sections.version,
    },
    {
      id: 'character.presentation',
      content: sections.presentation,
      version: sections.version,
    },
  ];
}
