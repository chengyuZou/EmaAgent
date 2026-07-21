// 测试 PromptAssembler 的稳定排序、版本身份、不可变快照和重复槽拒绝。

import { describe, expect, it } from 'vitest';
import { PromptAssembler } from '../promptAssembler.js';
import { PromptAssemblyError } from '../errors.js';
import type { PromptSlotContribution } from '../types.js';

const characterSlot: PromptSlotContribution = {
  id: 'character.identity',
  content: 'You are Ema.',
  version: 'ema:1',
};

const profileSlot: PromptSlotContribution = {
  id: 'profile.execution',
  content: 'Work carefully.',
  version: 'work:1',
};

describe('PromptAssembler', () => {
  it('按 order 稳定排序并生成与输入顺序无关的 revision', () => {
    const assembler = new PromptAssembler();
    const first = assembler.build([profileSlot, characterSlot]);
    const second = assembler.build([characterSlot, profileSlot]);

    expect(first.slots.map((slot) => slot.id)).toEqual([
      'character.identity',
      'profile.execution',
    ]);
    expect(first.systemText).toBe('You are Ema.\n\nWork carefully.');
    expect(first.slots[0]).toEqual(expect.objectContaining({
      order: 60,
      cacheScope: 'session',
      trust: 'user-configured',
    }));
    expect(first.revision).toBe(second.revision);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.slots)).toBe(true);
  });

  it('拒绝重复 slot id', () => {
    const assembler = new PromptAssembler();

    expect(() => assembler.build([characterSlot, characterSlot])).toThrowError(
      expect.objectContaining<Partial<PromptAssemblyError>>({
        code: 'prompt/duplicate-slot',
      }),
    );
  });
});
