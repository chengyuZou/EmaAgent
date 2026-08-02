// 测试上下文用量分类:槽位归口、贡献来源、媒体归附件与分类合计一致性。
import { describe, expect, it } from 'vitest';
import { computeContextUsage, type ContextUsageInput } from '../contextUsage.js';
import type { PromptSnapshot } from '@ema-agent/prompts';

function promptSnapshot(slots: Array<{ id: string; content: string }>): PromptSnapshot {
  return {
    slots: slots.map((slot, index) => ({
      id: slot.id,
      kind: 'rules',
      order: index,
      content: slot.content,
      version: 'v1',
      stabilityScope: 'turn',
      delivery: 'system',
      trust: 'product',
    })),
    systemBlocks: [],
    contextBlocks: [],
    revisions: { product: 'p', activeCharacter: 'c', turn: 't', complete: 'all' },
    revision: 'all',
  } as unknown as PromptSnapshot;
}

function baseInput(): ContextUsageInput {
  return {
    prompt: promptSnapshot([
      { id: 'product.rules', content: 'x'.repeat(400) },
      { id: 'character.identity', content: 'x'.repeat(200) },
      { id: 'workspace.instructions', content: 'x'.repeat(80) },
      { id: 'extension.skillCatalog', content: 'x'.repeat(40) },
    ]),
    toolManifest: {
      registryVersion: 1,
      revision: 'r1',
      entries: [{
        id: 'FileRead',
        name: 'FileRead',
        origin: { kind: 'builtin' },
        description: '读取文件',
        inputJsonSchema: { type: 'object' },
      }],
    },
    history: [
      { role: 'user', content: '历史问题' },
      { role: 'assistant', content: '历史回答' },
    ],
    currentTurn: [
      { role: 'user', content: [{ type: 'text', text: '看图' }, {
        type: 'image_data', data: 'base64…', mimeType: 'image/png',
        width: 1024, height: 768,
      } as never] },
    ],
    contributions: [
      { id: 'm', source: 'memory', placement: 'beforeCurrentTurn', message: { role: 'user', content: '记忆片段' } },
      { id: 'n', source: 'narrative', placement: 'beforeCurrentTurn', message: { role: 'user', content: '剧情片段' } },
      { id: 't', source: 'tasks', placement: 'beforeCurrentTurn', message: { role: 'user', content: '任务提醒' } },
    ],
    contextWindow: 200_000,
  };
}

describe('computeContextUsage', () => {
  it('Prompt 槽与 Tool Manifest 分别归口', () => {
    const { categories } = computeContextUsage(baseInput());
    expect(categories.systemPrompt).toBeGreaterThan(0);
    expect(categories.toolInstructions).toBeGreaterThan(0);
    expect(categories.workspaceInstructions).toBeGreaterThan(0);
    expect(categories.skills).toBeGreaterThan(0);
    expect(categories.systemPrompt).toBeGreaterThan(categories.toolInstructions);
  });

  it('贡献按 source 归口 memory/narrative/other', () => {
    const { categories } = computeContextUsage(baseInput());
    expect(categories.memory).toBeGreaterThan(0);
    expect(categories.narrative).toBeGreaterThan(0);
    expect(categories.other).toBeGreaterThan(0);
  });

  it('当前 Turn 的图片归入 attachments 而非 messages', () => {
    const { categories } = computeContextUsage(baseInput());
    // 1024×768/750 ≈ 1049 token 的图片必须落在 attachments
    expect(categories.attachments).toBeGreaterThanOrEqual(1000);
    expect(categories.messages).toBeGreaterThan(0);
  });

  it('分类合计恒等于 totalTokens,且永远标 heuristic', () => {
    const estimate = computeContextUsage(baseInput());
    const sum = Object.values(estimate.categories).reduce((a, b) => a + b, 0);
    expect(sum).toBe(estimate.totalTokens);
    expect(estimate.accuracy).toBe('heuristic');
    expect(estimate.contextWindow).toBe(200_000);
  });

  it('无 manifest 与贡献时对应类为零', () => {
    const input = baseInput();
    const estimate = computeContextUsage({
      ...input,
      toolManifest: undefined,
      contributions: undefined,
    });
    expect(estimate.categories.toolSchemas).toBe(0);
    expect(estimate.categories.toolInstructions).toBe(0);
    expect(estimate.categories.memory).toBe(0);
    expect(estimate.categories.narrative).toBe(0);
    expect(estimate.totalTokens).toBeGreaterThan(0);
  });
});
