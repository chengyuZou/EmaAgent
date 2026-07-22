// 校验并稳定排序模型指令槽，生成可诊断、可版本化的 Prompt 快照。

import { createHash } from 'node:crypto';
import { PromptAssemblyError } from './errors.js';
import type {
  PromptSlot,
  PromptBlock,
  PromptSlotContribution,
  PromptStabilityScope,
  PromptSnapshot,
} from './types.js';
import { PROMPT_SLOT_SPECS, PROMPT_STABILITY_ORDER } from './slots.js';

export class PromptAssembler {
  build(input: readonly PromptSlotContribution[]): PromptSnapshot {
    const slots = input.map(copyAndValidateSlot);
    assertUniqueIds(slots);
    slots.sort(compareSlots);

    const frozenSlots = Object.freeze(
      slots.map((slot) => Object.freeze(slot)),
    );
    const systemBlocks = buildBlocks(frozenSlots, 'system');
    const contextBlocks = buildBlocks(frozenSlots, 'context');
    const revisions = Object.freeze({
      product: computeScopeRevision(frozenSlots, 'product'),
      activeCharacter: computeScopeRevision(frozenSlots, 'activeCharacter'),
      turn: computeScopeRevision(frozenSlots, 'turn'),
      complete: computeRevision(frozenSlots),
    });

    return Object.freeze({
      slots: frozenSlots,
      systemBlocks,
      contextBlocks,
      revisions,
      revision: revisions.complete,
    });
  }
}

function buildBlocks(
  slots: readonly PromptSlot[],
  delivery: PromptSlot['delivery'],
): readonly PromptBlock[] {
  const blocks = PROMPT_STABILITY_ORDER.flatMap((stabilityScope) => {
    const selected = slots.filter(
      (slot) => slot.delivery === delivery && slot.stabilityScope === stabilityScope,
    );
    if (selected.length === 0) return [];
    return [Object.freeze({
      stabilityScope,
      delivery,
      content: selected.map((slot) => slot.content).join('\n\n'),
      revision: computeRevision(selected),
      cacheBreakpoint: stabilityScope !== 'turn',
    })];
  });
  return Object.freeze(blocks);
}

function copyAndValidateSlot(contribution: PromptSlotContribution): PromptSlot {
  const spec = PROMPT_SLOT_SPECS[contribution.id];
  if (!spec) {
    throw new PromptAssemblyError(
      'prompt/invalid-slot',
      `未知 Prompt 槽 ${String(contribution.id)}。`,
    );
  }
  if (!contribution.content.trim()) {
    throw new PromptAssemblyError(
      'prompt/invalid-slot',
      `Prompt 槽 ${contribution.id} 的 content 不能为空。`,
    );
  }
  if (!contribution.version.trim()) {
    throw new PromptAssemblyError(
      'prompt/invalid-slot',
      `Prompt 槽 ${contribution.id} 的 version 不能为空。`,
    );
  }

  return { ...contribution, ...spec };
}

function assertUniqueIds(slots: readonly PromptSlot[]): void {
  const ids = new Set<string>();
  for (const slot of slots) {
    if (ids.has(slot.id)) {
      throw new PromptAssemblyError(
        'prompt/duplicate-slot',
        `Prompt 槽 ${slot.id} 重复，不能依赖后写覆盖前写。`,
      );
    }
    ids.add(slot.id);
  }
}

function compareSlots(left: PromptSlot, right: PromptSlot): number {
  if (left.order !== right.order) return left.order - right.order;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function computeRevision(slots: readonly PromptSlot[]): string {
  const serialized = JSON.stringify({
    schemaVersion: 2,
    slots: slots.map((slot) => ({
      id: slot.id,
      kind: slot.kind,
      order: slot.order,
      content: slot.content,
      version: slot.version,
      stabilityScope: slot.stabilityScope,
      delivery: slot.delivery,
      trust: slot.trust,
    })),
  });

  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

function computeScopeRevision(
  slots: readonly PromptSlot[],
  scope: PromptStabilityScope,
): string {
  return computeRevision(slots.filter((slot) => slot.stabilityScope === scope));
}
