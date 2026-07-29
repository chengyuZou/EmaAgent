// 测试召回候选的 LLM 语义精选与失败回退语义。

import { describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from '@ema-agent/llm';
import { selectRelevantMemories } from '../recall/selectRelevant.js';
import type { RecalledItem, RecalledNode } from '../types.js';

const BINDING = { providerConfigId: 'provider-test', model: 'model-test' };
const bindings = { get: () => BINDING };

const nodes: RecalledNode[] = [
  { id: 'n1', label: '苹果', nodeType: 'entity', description: '用户喜欢吃的水果', importance: 60, hopDistance: 0 },
  { id: 'n2', label: '苹果手机', nodeType: 'entity', description: '用户上周买的 iPhone 17', importance: 70, hopDistance: 0 },
];

const items: RecalledItem[] = [
  { id: 'm1', kind: 'project', title: '发布冻结', body: '移动端 3 月 5 日冻结', importance: 80, updatedAt: Date.now() },
];

function llmWithText(text: string): LanguageModel {
  return {
    complete: vi.fn(async () => ({
      blocks: [{ type: 'text' as const, text }],
    })),
  } as unknown as LanguageModel;
}

describe('selectRelevantMemories', () => {
  it('把 N/M 引用解析为真实条目 id', async () => {
    const selection = await selectRelevantMemories({
      llm: llmWithText('{"relevant_nodes": ["N2"], "relevant_items": ["M1"]}'),
      modelBindings: bindings as never,
      userInput: '我的 iPhone 怎么备份？',
      nodes,
      items,
    });

    expect(selection).toEqual({ nodeIds: ['n2'], itemIds: ['m1'] });
  });

  it('模型可以全部不选（空数组是合法结果，不是失败）', async () => {
    const selection = await selectRelevantMemories({
      llm: llmWithText('{"relevant_nodes": [], "relevant_items": []}'),
      modelBindings: bindings as never,
      userInput: '今天天气怎么样',
      nodes,
      items,
    });

    expect(selection).toEqual({ nodeIds: [], itemIds: [] });
  });

  it('引用越界、输出无法解析、未配置模型时返回 null（调用方回退粗筛）', async () => {
    const outOfRange = await selectRelevantMemories({
      llm: llmWithText('{"relevant_nodes": ["N9"], "relevant_items": []}'),
      modelBindings: bindings as never,
      userInput: 'x',
      nodes,
      items,
    });
    expect(outOfRange).toBeNull();

    const garbage = await selectRelevantMemories({
      llm: llmWithText('我选第二个'),
      modelBindings: bindings as never,
      userInput: 'x',
      nodes,
      items,
    });
    expect(garbage).toBeNull();

    const noBinding = await selectRelevantMemories({
      llm: llmWithText('{}'),
      modelBindings: { get: () => undefined } as never,
      userInput: 'x',
      nodes,
      items,
    });
    expect(noBinding).toBeNull();
  });

  it('LLM 调用失败时返回 null', async () => {
    const selection = await selectRelevantMemories({
      llm: { complete: vi.fn(async () => { throw new Error('provider down'); }) } as unknown as LanguageModel,
      modelBindings: bindings as never,
      userInput: 'x',
      nodes,
      items,
    });
    expect(selection).toBeNull();
  });

  it('无候选时直接返回 null，不发起模型调用', async () => {
    const llm = llmWithText('{}');
    const selection = await selectRelevantMemories({
      llm,
      modelBindings: bindings as never,
      userInput: 'x',
      nodes: [],
      items: [],
    });
    expect(selection).toBeNull();
    expect(llm.complete).not.toHaveBeenCalled();
  });
});
