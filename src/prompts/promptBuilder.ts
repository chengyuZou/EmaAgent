// 汇集产品、角色、执行 Profile 与扩展指令，生成一次 Turn 冻结的 Prompt 快照。

import { buildCharacterPromptSections } from '@ema-agent/characters';
import { buildExecutionProfileContribution } from './executionProfilePrompt.js';
import { PromptAssembler } from './promptAssembler.js';
import { buildProductPromptContributions } from './productPrompt.js';
import type {
  PromptBuildRequest,
  PromptSlotContribution,
  PromptSnapshot,
} from './types.js';

const assembler = new PromptAssembler();

export function buildPromptSnapshot(request: PromptBuildRequest): PromptSnapshot {
  return assembler.build([
    ...buildProductPromptContributions(),
    ...(request.extensionContributions ?? []),
    ...buildCharacterContributions(request.activeCharacter),
    buildExecutionProfileContribution(
      request.executionProfile,
      request.narrativePolicy,
    ),
  ]);
}

function buildCharacterContributions(
  character: PromptBuildRequest['activeCharacter'],
): PromptSlotContribution[] {
  const sections = buildCharacterPromptSections(character);
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
