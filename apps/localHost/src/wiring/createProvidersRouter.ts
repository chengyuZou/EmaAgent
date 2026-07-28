// 在 Composition Root 装配 Provider 配置、探测、模型池和 TTS 试听能力。
import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import {
  ModelBindingControl,
  ProviderConfiguration,
  ProviderProbe,
  modelsDevIdFor,
  providerCatalog,
  staticModelsFor,
  type Capability,
  type ConfiguredProvider,
} from '@ema-agent/provider';
import { TtsVoicePreview } from '@ema-agent/tts';
import { providersRoute } from '../routes/providers/index.js';
import { resolveVoice } from './providers/tts.js';
import { fetchVisionModels } from './providers/vision.js';
import { StorageProviderConfigurationStore } from './providers/providerConfigurationStore.js';
import { fetchEmbedModels } from './providers/embed.js';
import { fetchLlmModels } from './providers/llm.js';
import type { AppBindings } from './bindings.js';

export function createProvidersRouter(bindings: AppBindings): Hono {
  const configurationStore = new StorageProviderConfigurationStore(bindings.providers);
  const modelBindings = new ModelBindingControl(
    bindings.modelBindings,
    bindings.providerRuntime,
  );
  const configuration = new ProviderConfiguration(
    providerCatalog,
    configurationStore,
    bindings.modelBindings,
    bindings.providerRuntime,
    randomUUID,
  );
  const probe = new ProviderProbe(
    configurationStore,
    {
      firstEnabled: (providerId, capability) => {
        switch (capability) {
          case 'llm':
            return bindings.providerLlmModels.listByProvider(providerId)[0]?.model;
          case 'embed':
            return bindings.providerEmbedModels.listByProvider(providerId)[0]?.model;
          case 'rerank':
            return bindings.providerRerankModels.listByProvider(providerId)[0]?.model;
          case 'vision':
            return bindings.providerVisionModels.listByProvider(providerId)[0]?.model;
          case 'tts':
            return bindings.providerTtsModels.listByProvider(providerId)[0]?.model;
          case 'stt':
            return bindings.providerSttModels.listByProvider(providerId)[0]?.model;
        }
      },
      firstCatalog: (provider, capability) => {
        return firstCatalogModel(bindings, provider, capability);
      },
    },
    {
      probe: async (providerId, capability, model, signal) => {
        switch (capability) {
          case 'llm':
            return bindings.llm.probe(providerId, model!, signal);
          case 'embed':
            return bindings.embed.probe(providerId, model!, signal);
          case 'rerank':
            return bindings.rerank.probe(providerId, model!, signal);
          case 'vision':
            return bindings.vision.probe(providerId, model!, signal);
          case 'tts':
            return bindings.tts.probe(providerId, signal);
          case 'stt':
            return bindings.stt.probe(providerId, signal);
        }
      },
    },
    {
      record: (providerId, result) => {
        bindings.providers.recordHealth(
          providerId,
          result.ok ? 'ok' : 'failed',
          {
            latencyMs: result.latencyMs,
            lastError: result.error,
          },
        );
      },
    },
  );
  const ttsPreview = new TtsVoicePreview(
    bindings.tts,
    {
      current: () => {
        const card = bindings.card.current();
        const voice = resolveVoice(card.id, bindings.card);
        return voice ? { cardId: card.id, voice } : null;
      },
    },
    bindings.ttsVoiceHandles,
  );

  return providersRoute(
    configuration,
    probe,
    {
      providers: bindings.providers,
      modelBindings,
      llmModels: bindings.providerLlmModels,
      embedModels: bindings.providerEmbedModels,
      rerankModels: bindings.providerRerankModels,
      ttsModels: bindings.providerTtsModels,
      sttModels: bindings.providerSttModels,
      visionModels: bindings.providerVisionModels,
      modelCatalog: bindings.modelCatalog,
      modelCapabilities: bindings.modelCapabilities,
      embed: bindings.embed,
      fetchLlmModels,
      fetchEmbedModels,
      fetchVisionModels,
    },
    ttsPreview,
  );
}

function firstCatalogModel(
  bindings: Pick<AppBindings, 'modelCatalog'>,
  provider: ConfiguredProvider,
  capability: Capability,
): string | undefined {
  const definition = providerCatalog.get(provider.definitionId);
  if (!definition) return undefined;
  if (capability === 'llm') {
    const modelsDevId = modelsDevIdFor(definition, 'llm');
    return modelsDevId
      ? bindings.modelCatalog.listLlmModelIds(modelsDevId)[0]
      : undefined;
  }
  return staticModelsFor(definition, capability)[0];
}
