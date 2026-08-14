// 测试 Provider 配置刷新会原子替换执行面，并向 Narrative Bridge 推送完整模型绑定快照。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, ModelBindingsRepo, ProvidersRepo } from '@ema-agent/storage';
import { LanguageModelRuntime } from '@ema-agent/llm';
import { EmbedRuntime } from '@ema-agent/embed';
import { RerankRuntime } from '@ema-agent/rerank';
import { TtsRuntime } from '@ema-agent/tts';
import { SttRuntime } from '@ema-agent/stt';
import { VisionRuntime } from '@ema-agent/vision';
import type {
  NarrativeBridgeConfigurePayload,
  NarrativeClient,
} from '@ema-agent/narrative';
import { ProviderRuntimeFacade } from '../src/wiring/provider-runtime.js';
import {
  ProviderConfiguration,
  providerCatalog,
} from '@ema-agent/provider';
import { providerConfigurationRoute } from '../src/routes/providers/providerConfiguration.js';
import { StorageProviderConfigurationStore } from '../src/wiring/providers/providerConfigurationStore.js';
import { createTestCredentialFacade } from './helpers/test-credential-facade.js';
import type { UsageRecorder } from '@ema-agent/usage';

const noopRecorder: UsageRecorder = { record: () => undefined };

class NarrativeClientSpy {
  readonly payloads: NarrativeBridgeConfigurePayload[] = [];

  updateBaseUrl(_url: string): void {}

  async configure(payload: NarrativeBridgeConfigurePayload): Promise<boolean> {
    this.payloads.push(payload);
    return true;
  }
}

describe('ProviderRuntimeFacade', () => {
  let profileDb: Database;
  let providers: ProvidersRepo;
  let llm: LanguageModelRuntime;
  let embed: EmbedRuntime;
  let rerank: RerankRuntime;
  let tts: TtsRuntime;
  let stt: SttRuntime;
  let vision: VisionRuntime;
  let narrative: NarrativeClientSpy;
  let runtime: ProviderRuntimeFacade;

  beforeEach(() => {
    profileDb = new Database({ memory: true, kind: 'profile' });
    profileDb.migrate();
    providers = new ProvidersRepo(profileDb.sqlite, createTestCredentialFacade());
    llm = new LanguageModelRuntime([], undefined, { usageRecorder: noopRecorder });
    embed = new EmbedRuntime([], { usageRecorder: noopRecorder });
    rerank = new RerankRuntime([], { usageRecorder: noopRecorder });
    tts = new TtsRuntime({ configs: [], usageRecorder: noopRecorder });
    stt = new SttRuntime({ configs: [], usageRecorder: noopRecorder });
    vision = new VisionRuntime({ configs: [], usageRecorder: noopRecorder });
    narrative = new NarrativeClientSpy();
    runtime = new ProviderRuntimeFacade({
      profileDb,
      llm,
      embed,
      rerank,
      tts,
      stt,
      vision,
      narrative: narrative as unknown as NarrativeClient,
      credentials: createTestCredentialFacade(),
    });
  });

  afterEach(() => {
    profileDb.close();
  });

  it('撤掉 capability 后从所有对应运行时删除旧 Adapter', () => {
    providers.upsert({
      id: 'multi-provider',
      definitionId: 'siliconflow',
      displayName: 'SiliconFlow',
      apiKey: 'secret-v1',
      capabilities: [
        { capability: 'llm' },
        { capability: 'embed' },
        { capability: 'rerank' },
        { capability: 'vision' },
        { capability: 'tts' },
        { capability: 'stt' },
      ],
    });

    runtime.refreshProviders();

    expect(llm.getProtocol('multi-provider')).toBe('openai-llm');
    expect(embed.getProtocol('multi-provider')).toBe('openai-embed');
    expect(rerank.getProtocol('multi-provider')).toBe('cohere-rerank');
    expect(vision.getProtocol('multi-provider')).toBe('openai-vision');
    expect(tts.healthCheck().providers.map((provider) => provider.providerId)).toEqual(['multi-provider']);
    expect(stt.healthCheck().providers.map((provider) => provider.providerId)).toEqual(['multi-provider']);

    providers.upsert({
      id: 'multi-provider',
      definitionId: 'siliconflow',
      displayName: 'SiliconFlow',
      apiKey: 'secret-v2',
      capabilities: [{ capability: 'llm' }],
    });
    runtime.refreshProviders();

    expect(llm.getProtocol('multi-provider')).toBe('openai-llm');
    expect(embed.getProtocol('multi-provider')).toBeUndefined();
    expect(rerank.getProtocol('multi-provider')).toBeUndefined();
    expect(vision.getProtocol('multi-provider')).toBeUndefined();
    expect(tts.healthCheck().providers).toHaveLength(0);
    expect(stt.healthCheck().providers).toHaveLength(0);
  });

  it('禁用或删除 Provider 后新请求不再能取得旧运行时', () => {
    providers.upsert({
      id: 'provider-1',
      definitionId: 'openai',
      displayName: 'OpenAI',
      apiKey: 'secret',
      capabilities: [{ capability: 'llm' }, { capability: 'vision' }],
    });
    runtime.refreshProviders();

    providers.setEnabled('provider-1', false);
    runtime.refreshProviders();

    expect(llm.getProtocol('provider-1')).toBeUndefined();
    expect(vision.getProtocol('provider-1')).toBeUndefined();
    expect(() => llm.stream({ providerId: 'provider-1', model: 'gpt', messages: [] }))
      .toThrow('provider/not_configured');

    providers.setEnabled('provider-1', true);
    runtime.refreshProviders();
    expect(llm.getProtocol('provider-1')).toBe('openai-llm');

    providers.delete('provider-1');
    runtime.refreshProviders();
    expect(llm.getProtocol('provider-1')).toBeUndefined();
  });

  it('Bridge 使用完整快照并在绑定消失后显式发送 null', async () => {
    providers.upsert({
      id: 'provider-1',
      definitionId: 'siliconflow',
      displayName: 'SiliconFlow',
      apiKey: 'bridge-secret',
      capabilities: [{ capability: 'llm' }, { capability: 'embed' }],
    });
    const modelBindings = new ModelBindingsRepo(profileDb.sqlite);
    modelBindings.upsert({
      module: 'lightrag-llm',
      providerConfigId: 'provider-1',
      model: 'llm-model',
    });
    modelBindings.upsert({
      module: 'lightrag-embed',
      providerConfigId: 'provider-1',
      model: 'embed-model',
      embeddingDimension: 1024,
    });

    await runtime.syncNarrativeBridge();
    expect(narrative.payloads.at(-1)).toMatchObject({
      llm: { apiKey: 'bridge-secret', model: 'llm-model' },
      embed: { apiKey: 'bridge-secret', model: 'embed-model', dim: 1024 },
    });

    providers.setEnabled('provider-1', false);
    await runtime.syncNarrativeBridge();
    expect(narrative.payloads.at(-1)).toEqual({ llm: null, embed: null });

    providers.setEnabled('provider-1', true);
    modelBindings.deleteAllByModule('lightrag-llm');
    modelBindings.deleteAllByModule('lightrag-embed');
    providers.delete('provider-1');
    await runtime.syncNarrativeBridge();
    expect(narrative.payloads.at(-1)).toEqual({ llm: null, embed: null });
  });

  it('被业务绑定引用时拒绝删除 Provider 或撤掉所需 capability', async () => {
    providers.upsert({
      id: 'provider-1',
      definitionId: 'siliconflow',
      displayName: 'SiliconFlow',
      apiKey: 'secret',
      capabilities: [{ capability: 'llm' }, { capability: 'embed' }],
    });
    const modelBindings = new ModelBindingsRepo(profileDb.sqlite);
    modelBindings.upsert({
      module: 'lightrag-embed',
      providerConfigId: 'provider-1',
      model: 'embed-model',
    });
    const app = providerConfigurationRoute(new ProviderConfiguration(
      providerCatalog,
      new StorageProviderConfigurationStore(providers),
      modelBindings,
      { refresh() {} },
      () => 'new-provider',
    ));

    const patchResponse = await app.request('/provider-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capability: { capability: 'embed', enabled: false },
      }),
    });
    expect(patchResponse.status).toBe(409);
    await expect(patchResponse.json()).resolves.toMatchObject({
      error: 'provider_capability_in_use',
      bindings: [{ module: 'lightrag-embed', capability: 'embed' }],
    });

    const deleteResponse = await app.request('/provider-1', { method: 'DELETE' });
    expect(deleteResponse.status).toBe(409);
    await expect(deleteResponse.json()).resolves.toMatchObject({
      error: 'provider_in_use',
      bindings: [{ module: 'lightrag-embed' }],
    });
    expect(providers.get('provider-1')).toBeDefined();
  });
});
