// 组合 Provider 配置、能力探测、模型池和声音试听子资源，保持既有 URL 不变。
import { Hono } from 'hono';
import type {
  ProviderConfiguration,
  ProviderProbe,
} from '@ema-agent/provider';
import type { TtsVoicePreview } from '@ema-agent/tts';
import { providerConfigurationRoute } from './providerConfiguration.js';
import {
  providerModelsRoute,
  type ProviderModelsRouteDependencies,
} from './providerModels.js';
import { providerProbesRoute } from './providerProbes.js';
import { providerTtsPreviewRoute } from './providerTtsPreview.js';

export function providersRoute(
  configuration: ProviderConfiguration,
  probe: ProviderProbe,
  models: ProviderModelsRouteDependencies,
  ttsPreview: TtsVoicePreview,
): Hono {
  const app = new Hono();
  app.route('/', providerModelsRoute(models));
  app.route('/', providerProbesRoute(probe));
  app.route('/', providerTtsPreviewRoute(ttsPreview));
  app.route('/', providerConfigurationRoute(configuration));
  return app;
}
