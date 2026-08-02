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
    expect(first.systemBlocks.map((block) => block.content)).toEqual([
      'You are Ema.',
      'Work carefully.',
    ]);
    expect(first.slots[0]).toEqual(expect.objectContaining({
      order: 60,
      stabilityScope: 'activeCharacter',
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

  it('workspace.instructions 继承声明的槽位规格', () => {
    const assembler = new PromptAssembler();
    const snapshot = assembler.build([
      characterSlot,
      { id: 'workspace.instructions', content: 'Project rules.', version: 'ws:1' },
    ]);

    expect(snapshot.slots.map((slot) => slot.id)).toEqual([
      'workspace.instructions',
      'character.identity',
    ]);
    expect(snapshot.slots[0]).toEqual(expect.objectContaining({
      order: 50, stabilityScope: 'session', delivery: 'context',
    }));
  });

  it('参数化 Skill 槽按前缀继承规格,空后缀与未知前缀拒绝', () => {
    const assembler = new PromptAssembler();
    const snapshot = assembler.build([
      { id: 'skills.required.ema-guide', content: 'Always on.', version: 'sk:1' },
      { id: 'skills.active.review', content: 'Active now.', version: 'sk:1' },
    ]);

    expect(snapshot.slots[0]).toEqual(expect.objectContaining({
      id: 'skills.required.ema-guide', order: 35, stabilityScope: 'product',
      delivery: 'system',
    }));
    expect(snapshot.slots[1]).toEqual(expect.objectContaining({
      id: 'skills.active.review', order: 55, stabilityScope: 'turn',
      delivery: 'context',
    }));

    expect(() => assembler.build([
      { id: 'skills.required.', content: 'x', version: 'v' },
    ])).toThrowError(expect.objectContaining<Partial<PromptAssemblyError>>({
      code: 'prompt/invalid-slot',
    }));
    expect(() => assembler.build([
      { id: 'skills.other.x' as never, content: 'x', version: 'v' },
    ])).toThrowError(expect.objectContaining<Partial<PromptAssemblyError>>({
      code: 'prompt/invalid-slot',
    }));
  });

  it('session 稳定范围在 activeCharacter 与 turn 之间成块', () => {
    const assembler = new PromptAssembler();
    const snapshot = assembler.build([
      { id: 'product.rules', content: 'Product.', version: 'p:1' },
      { id: 'workspace.instructions', content: 'Workspace.', version: 'ws:1' },
      profileSlot,
      characterSlot,
    ]);

    expect(snapshot.systemBlocks.map((block) => block.stabilityScope)).toEqual([
      'product',
      'activeCharacter',
      'turn',
    ]);
    expect(snapshot.contextBlocks.map((block) => block.stabilityScope)).toEqual([
      'session',
    ]);
    expect(snapshot.contextBlocks[0]!.cacheBreakpoint).toBe(true);
    expect(snapshot.systemBlocks.find((b) => b.stabilityScope === 'turn')!.cacheBreakpoint).toBe(false);
  });
});
