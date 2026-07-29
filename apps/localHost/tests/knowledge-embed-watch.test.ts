// 测试 kb.models 设置变更后自动失效全部 KB 并发出引导事件的 wiring 挂钩。
import { describe, expect, it, vi } from 'vitest';
import { knowledgeModelsSetting, type KnowledgeModelRef } from '@ema-agent/knowledge';
import type { SettingsChangedListener } from '@ema-agent/settings';
import { watchKnowledgeEmbedModel } from '../src/wiring/createKnowledgeRuntime.js';

const EMBED_A: KnowledgeModelRef = { providerConfigId: 'p-1', model: 'embed-a' };
const EMBED_B: KnowledgeModelRef = { providerConfigId: 'p-1', model: 'embed-b' };

interface Harness {
  fire(changedKeys: string[]): void;
  setEmbed(embed: KnowledgeModelRef | undefined): void;
  invalidate: ReturnType<typeof vi.fn>;
  emitEvent: ReturnType<typeof vi.fn>;
  unwatch: () => void;
}

function createHarness(initialEmbed: KnowledgeModelRef | undefined): Harness {
  let currentEmbed = initialEmbed;
  let listener: SettingsChangedListener | undefined;
  const settings = {
    get: (definition: { key: string }) => {
      if (definition.key !== knowledgeModelsSetting.key) throw new Error('unexpected setting key');
      return currentEmbed ? { embed: currentEmbed } : {};
    },
    subscribe: (l: SettingsChangedListener) => {
      listener = l;
      return () => { listener = undefined; };
    },
  };
  const invalidate = vi.fn(async () => ({ kbCount: 2, markedStale: 7, failedKbIds: [] as string[] }));
  const emitEvent = vi.fn();

  const unwatch = watchKnowledgeEmbedModel({
    settings: settings as never,
    providerEmbedModels: { dimFor: () => 3 } as never,
    embed: { embeddingSpace: () => ({ id: 'space-new' }) } as never,
    kb: { invalidateAllEmbeddings: invalidate },
    emitEvent,
  });

  return {
    fire: (changedKeys) => listener?.({ revision: 1, changedKeys }),
    setEmbed: (embed) => { currentEmbed = embed; },
    invalidate,
    emitEvent,
    unwatch,
  };
}

async function flushInvalidations(): Promise<void> {
  // tail 链上的 invalidate + emit 全部落定。
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('watchKnowledgeEmbedModel', () => {
  it('embed 引用变化时失效全部 KB 并发出引导事件', async () => {
    const h = createHarness(EMBED_A);
    h.setEmbed(EMBED_B);
    h.fire([knowledgeModelsSetting.key]);
    await flushInvalidations();

    expect(h.invalidate).toHaveBeenCalledWith('space-new');
    expect(h.emitEvent).toHaveBeenCalledWith({
      type: 'kb_embeddings_staled',
      markedStale: 7,
      kbCount: 2,
      failedKbIds: [],
      providerConfigId: 'p-1',
      model: 'embed-b',
    });
  });

  it('无关设置键与 embed 引用未变的变更都不触发', async () => {
    const h = createHarness(EMBED_A);
    h.fire(['theme']);
    h.fire([knowledgeModelsSetting.key]); // embed 引用没变（例如只改 rerank）
    await flushInvalidations();

    expect(h.invalidate).not.toHaveBeenCalled();
    expect(h.emitEvent).not.toHaveBeenCalled();
  });

  it('embed 引用被移除时不失效、不报警', async () => {
    const h = createHarness(EMBED_A);
    h.setEmbed(undefined);
    h.fire([knowledgeModelsSetting.key]);
    await flushInvalidations();

    expect(h.invalidate).not.toHaveBeenCalled();
    expect(h.emitEvent).not.toHaveBeenCalled();
  });

  it('维度未知的模型跳过失效且不发出事件', async () => {
    let currentEmbed: KnowledgeModelRef | undefined = EMBED_A;
    let listener: SettingsChangedListener | undefined;
    const emitEvent = vi.fn();
    const invalidate = vi.fn();
    watchKnowledgeEmbedModel({
      settings: {
        get: () => (currentEmbed ? { embed: currentEmbed } : {}),
        subscribe: (l: SettingsChangedListener) => { listener = l; return () => {}; },
      } as never,
      providerEmbedModels: { dimFor: () => undefined } as never,
      embed: { embeddingSpace: () => ({ id: 'space-new' }) } as never,
      kb: { invalidateAllEmbeddings: invalidate },
      emitEvent,
    });

    currentEmbed = EMBED_B;
    listener?.({ revision: 1, changedKeys: [knowledgeModelsSetting.key] });
    await flushInvalidations();

    expect(invalidate).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('连续多次变更按顺序串行执行', async () => {
    const h = createHarness(EMBED_A);
    const embedC: KnowledgeModelRef = { providerConfigId: 'p-2', model: 'embed-c' };

    h.setEmbed(EMBED_B);
    h.fire([knowledgeModelsSetting.key]);
    h.setEmbed(embedC);
    h.fire([knowledgeModelsSetting.key]);
    await flushInvalidations();

    expect(h.invalidate).toHaveBeenCalledTimes(2);
    expect(h.emitEvent).toHaveBeenCalledTimes(2);
    expect(h.emitEvent.mock.calls[0]![0].model).toBe('embed-b');
    expect(h.emitEvent.mock.calls[1]![0].model).toBe('embed-c');
  });

  it('unwatch 后不再响应变更', async () => {
    const h = createHarness(EMBED_A);
    h.unwatch();
    h.setEmbed(EMBED_B);
    h.fire([knowledgeModelsSetting.key]);
    await flushInvalidations();

    expect(h.invalidate).not.toHaveBeenCalled();
  });
});
