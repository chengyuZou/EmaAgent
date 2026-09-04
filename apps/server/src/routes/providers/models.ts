// 模型池与业务绑定：provider_models 行读写、启停开关、目录同步、绑定选择器的可用清单、model_bindings 读写。
import { Hono } from 'hono';
import { z } from 'zod';
import {
  MODEL_BINDING_CAPABILITIES,
  MODEL_BINDING_MODULES,
  ProviderError,
  type ModelBindingModule,
  type ModelBindings,
  type ProviderModels,
  type Providers,
} from '@ema-agent/providers';
import { providerError } from './configs.js';
import { jsonBody, paramValidator, queryValidator } from '../validate.js';

const capabilityEnum = z.enum(['llm', 'embed', 'rerank', 'vision', 'tts', 'stt']);

const availableParams = z.object({
  capability: capabilityEnum,
});

/** modelId 跨能力不唯一，按行寻址的端点都要带 capability 判别。 */
const modelQuery = z.object({
  capability: capabilityEnum,
});

const refreshQuery = z.object({
  capability: z.enum(['llm', 'vision']),
});

const bindingParams = z.object({
  module: z.enum(MODEL_BINDING_MODULES),
});

const llmParams = {
  contextWindow: z.number().int().positive(),
  maxOutput: z.number().int().positive().nullable().default(null),
  toolCall: z.boolean().nullable().default(null),
  reasoning: z.boolean().nullable().default(null),
  temperature: z.boolean().nullable().default(null),
  inputImage: z.boolean().nullable().default(null),
};

/** 能力判别联合：参数形状按能力分流，llm/vision 同参数集；name 不经 API 修改。 */
const providerModelBody = z.discriminatedUnion('capability', [
  z.object({ capability: z.literal('llm'), modelId: z.string().min(1), ...llmParams }),
  z.object({ capability: z.literal('vision'), modelId: z.string().min(1), ...llmParams }),
  z.object({
    capability: z.literal('embed'),
    modelId: z.string().min(1),
    dim: z.number().int().positive(),
  }),
  z.object({
    capability: z.literal('rerank'),
    modelId: z.string().min(1),
    maxChunks: z.number().int().positive().nullable().default(null),
  }),
  z.object({ capability: z.literal('tts'), modelId: z.string().min(1) }),
  z.object({ capability: z.literal('stt'), modelId: z.string().min(1) }),
]);

const bindingBody = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
});

const toggleModelBody = z.object({
  enabled: z.boolean(),
});

export interface ProviderModelsRouteDeps {
  readonly providers: Providers;
  readonly providerModels: ProviderModels;
  readonly modelBindings: ModelBindings;
  /** models.dev 目录网络刷新；同步到 SQL 由 syncDevModels 负责。 */
  readonly refreshCatalog: (signal?: AbortSignal) => Promise<boolean>;
}

export const providerModelsRoute = (deps: ProviderModelsRouteDeps) =>
  new Hono()
    // 绑定选择器的可用清单：连接可解析（协议档在位、bearer 有 key）且已启用的 Provider 池行。
    .get('/available/:capability', paramValidator(availableParams), context => {
      const { capability } = context.req.valid('param');
      const usable = new Set<string>();
      for (const provider of deps.providers.list()) {
        try {
          deps.providers.resolveConnection(provider.id, capability);
          usable.add(provider.id);
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
        }
      }
      const models = deps.providerModels.listByCapability(capability)
        .filter(model => model.enabled && usable.has(model.providerId));
      return context.json({ models });
    })
    // 首次使用判定：provider_models 是否已有任何模型行（静态路径先于 /:providerId 注册）。
    .get('/models/has-any', context => context.json({ hasAny: deps.providerModels.hasAny() }))
    .get('/:providerId/models', context => {
      try {
        return context.json(deps.providerModels.listByProvider(context.req.param('providerId')));
      } catch (error) {
        return providerError(context, error);
      }
    })
    // 刷新：网络拉一次 models.dev 目录，再把该能力的目录模型同步进 SQL（新增默认禁用）。
    .post('/:providerId/models/refresh', queryValidator(refreshQuery), async context => {
      const { capability } = context.req.valid('query');
      try {
        await deps.refreshCatalog()
          .catch(error => console.warn('[providers] models.dev 目录刷新失败:', error));
        const models = deps.providerModels.syncDevModels(context.req.param('providerId'), capability);
        return context.json({ models });
      } catch (error) {
        return providerError(context, error);
      }
    })
    .put('/:providerId/models', jsonBody(providerModelBody), async context => {
      try {
        return context.json(deps.providerModels.save({
          providerId: context.req.param('providerId'),
          ...context.req.valid('json'),
        }));
      } catch (error) {
        return providerError(context, error);
      }
    })
    .patch('/:providerId/models/:modelId', queryValidator(modelQuery), jsonBody(toggleModelBody), context => {
      const { capability } = context.req.valid('query');
      const { enabled } = context.req.valid('json');
      try {
        return context.json(deps.providerModels.setEnabled(
          context.req.param('providerId'),
          capability,
          context.req.param('modelId'),
          enabled,
        ));
      } catch (error) {
        return providerError(context, error);
      }
    })
    .delete('/:providerId/models/:modelId', queryValidator(modelQuery), context => {
      const { capability } = context.req.valid('query');
      try {
        deps.providerModels.delete(context.req.param('providerId'), capability, context.req.param('modelId'));
        return context.body(null, 204);
      } catch (error) {
        return providerError(context, error);
      }
    })
    // ── 业务绑定（一个业务位一条绑定） ────────────────────────────────────────────
    .get('/bindings', context => context.json(deps.modelBindings.list()))
    .put('/bindings/:module', paramValidator(bindingParams), jsonBody(bindingBody), async context => {
      const { module } = context.req.valid('param');
      const body = context.req.valid('json');
      try {
        assertBindingConnection(deps, module, body.providerId);
        deps.modelBindings.set({ module, ...body });
        return context.json(deps.modelBindings.get(module));
      } catch (error) {
        return providerError(context, error);
      }
    })
    .delete('/bindings/:module', paramValidator(bindingParams), context => {
      const { module } = context.req.valid('param');
      deps.modelBindings.delete(module);
      return context.body(null, 204);
    });

/**
 * 绑定门槛：模块能力的连接必须可解析（协议档在位、bearer 有 key）——
 * 不让"绑定成功、执行时才炸"。Narrative Bridge 只实现 openai-llm/openai-embed
 * 两个协议族，它的两个模块额外锁定协议。
 */
const NARRATIVE_BINDING_PROTOCOLS = {
  'lightrag-llm': 'openai-llm',
  'lightrag-embed': 'openai-embed',
} as const;

function assertBindingConnection(
  deps: ProviderModelsRouteDeps,
  module: ModelBindingModule,
  providerId: string,
): void {
  const connection = deps.providers.resolveConnection(providerId, MODEL_BINDING_CAPABILITIES[module]);
  const expected = module === 'lightrag-llm' || module === 'lightrag-embed'
    ? NARRATIVE_BINDING_PROTOCOLS[module]
    : undefined;
  if (expected && connection.protocol !== expected) {
    throw new ProviderError(
      'invalid_configuration',
      `${module} 只支持 ${expected} 协议，当前 Provider 该能力为 ${connection.protocol}`,
    );
  }
}
