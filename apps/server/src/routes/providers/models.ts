// 模型池与业务绑定：provider_models 启停、绑定选择器的可用模型清单、model_bindings 读写。
import { Hono } from 'hono';
import { z } from 'zod';
import {
  MODEL_BINDING_MODULES,
  type ModelBindings,
  type ProviderModels,
  type Providers,
} from '@ema-agent/providers';
import { providerError } from './configs.js';

const llmParams = {
  contextWindow: z.number().int().positive(),
  maxOutput: z.number().int().positive().nullable().default(null),
  toolCall: z.boolean().nullable().default(null),
  reasoning: z.boolean().nullable().default(null),
  temperature: z.boolean().nullable().default(null),
  inputImage: z.boolean().nullable().default(null),
};

/** 能力判别联合：参数形状按能力分流，llm/vision 同参数集。 */
const providerModelBody = z.discriminatedUnion('capability', [
  z.object({ capability: z.literal('llm'), modelId: z.string().min(1), name: z.string().optional(), ...llmParams }),
  z.object({ capability: z.literal('vision'), modelId: z.string().min(1), name: z.string().optional(), ...llmParams }),
  z.object({
    capability: z.literal('embed'),
    modelId: z.string().min(1),
    name: z.string().optional(),
    dim: z.number().int().positive(),
  }),
  z.object({
    capability: z.literal('rerank'),
    modelId: z.string().min(1),
    name: z.string().optional(),
    maxChunks: z.number().int().positive().nullable().default(null),
  }),
  z.object({ capability: z.literal('tts'), modelId: z.string().min(1), name: z.string().optional() }),
  z.object({ capability: z.literal('stt'), modelId: z.string().min(1), name: z.string().optional() }),
]);

const bindingBody = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
});

export interface ProviderModelsRouteDeps {
  readonly providers: Providers;
  readonly providerModels: ProviderModels;
  readonly modelBindings: ModelBindings;
  /** kb-embed/kb-rerank 绑定变更后使全部 KB 嵌入失效（引导重嵌）；由装配层从 knowledge 族接线。 */
  readonly onKbEmbeddingBindingChanged?: () => void;
}

export function providerModelsRoute(deps: ProviderModelsRouteDeps): Hono {
  const app = new Hono();

  // 绑定选择器的可用模型清单：一次返回该能力下全部已启用模型及其 Provider 名。
  app.get('/available/:capability', context => {
    const capability = z.enum(['llm', 'embed', 'rerank', 'vision', 'tts', 'stt'])
      .safeParse(context.req.param('capability'));
    if (!capability.success) return context.json({ error: 'invalid_capability' }, 400);
    const providerNames = new Map(deps.providers.list().map(p => [p.id, p.name]));
    const models = deps.providerModels.listByCapability(capability.data)
      .filter(model => providerNames.has(model.providerId))
      .map(model => ({
        ...model,
        providerName: providerNames.get(model.providerId)!,
      }));
    return context.json({ models });
  });

  app.get('/:providerId/models', context => {
    try {
      return context.json(deps.providerModels.listByProvider(context.req.param('providerId')));
    } catch (error) {
      return providerError(context, error);
    }
  });

  app.put('/:providerId/models', async context => {
    const parsed = providerModelBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      return context.json(deps.providerModels.save({
        providerId: context.req.param('providerId'),
        ...parsed.data,
      }));
    } catch (error) {
      return providerError(context, error);
    }
  });

  app.delete('/:providerId/models/:modelId', context => {
    const capability = context.req.query('capability');
    const parsed = z.enum(['llm', 'embed', 'rerank', 'vision', 'tts', 'stt']).safeParse(capability);
    if (!parsed.success) return context.json({ error: 'invalid_capability' }, 400);
    try {
      deps.providerModels.delete(context.req.param('providerId'), parsed.data, context.req.param('modelId'));
      return context.body(null, 204);
    } catch (error) {
      return providerError(context, error);
    }
  });

  // ── 业务绑定（一个业务位一条绑定） ────────────────────────────────────────────
  app.get('/bindings', context => context.json(deps.modelBindings.list()));

  app.put('/bindings/:module', async context => {
    const module = z.enum(MODEL_BINDING_MODULES).safeParse(context.req.param('module'));
    if (!module.success) {
      return context.json({ error: 'invalid_module', validModules: MODEL_BINDING_MODULES }, 400);
    }
    const parsed = bindingBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      deps.modelBindings.set({ module: module.data, ...parsed.data });
      if (module.data === 'kb-embed' || module.data === 'kb-rerank') {
        deps.onKbEmbeddingBindingChanged?.();
      }
      return context.json(deps.modelBindings.get(module.data));
    } catch (error) {
      return providerError(context, error);
    }
  });

  app.delete('/bindings/:module', context => {
    const module = z.enum(MODEL_BINDING_MODULES).safeParse(context.req.param('module'));
    if (!module.success) {
      return context.json({ error: 'invalid_module', validModules: MODEL_BINDING_MODULES }, 400);
    }
    deps.modelBindings.delete(module.data);
    return context.body(null, 204);
  });

  return app;
}
