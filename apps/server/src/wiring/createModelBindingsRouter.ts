// 在 Composition Root 装配模型绑定控制面与各模态已启用模型目录。
import type { Hono } from 'hono';
import { ModelBindingControl } from '@ema-agent/provider';
import { modelBindingsRoute } from '../routes/modelBindings/index.js';
import type { AppBindings } from './bindings.js';

export function createModelBindingsRouter(bindings: AppBindings): Hono {
  const control = new ModelBindingControl(
    bindings.modelBindings,
    bindings.providerRuntime,
  );
  return modelBindingsRoute(control, {
    providers: bindings.providers,
    llmModels: bindings.providerLlmModels,
    embedModels: bindings.providerEmbedModels,
    rerankModels: bindings.providerRerankModels,
    ttsModels: bindings.providerTtsModels,
    sttModels: bindings.providerSttModels,
    visionModels: bindings.providerVisionModels,
    embed: bindings.embed,
  });
}
