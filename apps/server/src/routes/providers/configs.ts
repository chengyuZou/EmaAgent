// Provider 控制面：内置种子与自建同表同构的 CRUD；能力档位经 update 的 capability 单量修改。
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  PROTOCOLS,
  PROVIDER_LIMITS,
  ProviderError,
  type ProviderModels,
  type Providers,
} from '@ema-agent/providers';
import { jsonBody } from '../validate.js';

const capabilityInputSchema = z.object({
  capability: z.enum(['llm', 'embed', 'rerank', 'vision', 'tts', 'stt']),
  protocol: z.enum(PROTOCOLS).optional(),
  baseUrl: z.string().min(1).max(PROVIDER_LIMITS.baseUrlChars).optional(),
  /** true = 设为当前协议；false = 停用该能力（已配协议保留）。 */
  active: z.boolean().optional(),
  modelsDevId: z.string().optional(),
  /** 本次要从该能力移除的协议档；删到最后一档会报错。 */
  removedProtocols: z.array(z.enum(PROTOCOLS)).optional(),
});

const createProviderBody = z.object({
  id: z.string().min(1).max(PROVIDER_LIMITS.idChars),
  name: z.string().min(1).max(PROVIDER_LIMITS.nameChars),
  iconId: z.string().optional(),
  authType: z.enum(['none', 'bearer']),
  /** one key per provider；bearer 未提供时先建行。 */
  key: z.string().max(PROVIDER_LIMITS.apiKeyChars).optional(),
  capability: capabilityInputSchema,
});

const updateProviderBody = z.object({
  name: z.string().min(1).max(PROVIDER_LIMITS.nameChars).optional(),
  iconId: z.string().nullable().optional(),
  /** null = 清空 key；缺省 = 不动现有 key。 */
  key: z.string().min(1).max(PROVIDER_LIMITS.apiKeyChars).nullable().optional(),
  capability: capabilityInputSchema.optional(),
});

export interface ProviderConfigsRouteDeps {
  readonly providers: Providers;
  readonly providerModels: ProviderModels;
  /** models.dev 目录网络刷新（后台 fire-and-forget 链路用）。 */
  readonly refreshCatalog: (signal?: AbortSignal) => Promise<boolean>;
}

export const providerConfigsRoute = (deps: ProviderConfigsRouteDeps) =>
  new Hono()
    .get('/', context => context.json(deps.providers.list()))
    .post('/', jsonBody(createProviderBody), async context => {
      try {
        const created = deps.providers.create(context.req.valid('json'));
        syncDevModelsAfterConfig(deps, created.id);
        return context.json(created, 201);
      } catch (error) {
        return providerError(context, error);
      }
    })
    .get('/:providerId', context => {
      try {
        return context.json(deps.providers.get(context.req.param('providerId')));
      } catch (error) {
        return providerError(context, error);
      }
    })
    .patch('/:providerId', jsonBody(updateProviderBody), async context => {
      try {
        const provider = deps.providers.update(context.req.param('providerId'), context.req.valid('json'));
        syncDevModelsAfterConfig(deps, provider.id);
        return context.json(provider);
      } catch (error) {
        return providerError(context, error);
      }
    })
    .delete('/:providerId', context => {
      try {
        deps.providers.delete(context.req.param('providerId'));
        return context.body(null, 204);
      } catch (error) {
        return providerError(context, error);
      }
    });

/** ProviderError 的稳定 HTTP 映射；非领域错误继续上抛。 */
export function providerError(context: Context, error: unknown) {
  if (!(error instanceof ProviderError)) throw error;
  switch (error.code) {
    case 'not_found':
    case 'model_not_found':
      return context.json({ error: error.code }, 404);
    case 'already_exists':
    case 'provider_in_use':
    case 'provider_capability_in_use':
    case 'model_in_use':
      return context.json({ error: error.code, message: error.message, conflicts: error.conflicts }, 409);
    default:
      return context.json({ error: error.code, message: error.message }, 422);
  }
}

/**
 * 配置保存（create/update）成功后立刻同步一次目录模型：llm/vision 且收录了
 * models.dev 的 Provider 才有目录模型可落库。网络刷新失败不阻塞，快照照样同步。
 */
function syncDevModelsAfterConfig(deps: ProviderConfigsRouteDeps, providerId: string): void {
  let provider;
  try {
    provider = deps.providers.get(providerId);
  } catch {
    return;
  }
  const caps = provider.capabilities
    .filter(c => (c.capability === 'llm' || c.capability === 'vision') && c.modelsDevId !== undefined)
    .map(c => c.capability as 'llm' | 'vision');
  if (caps.length === 0) return;
  void deps.refreshCatalog()
    .catch(error => console.warn('[providers] models.dev 目录刷新失败:', error))
    .finally(() => {
      for (const capability of caps) {
        try {
          deps.providerModels.syncDevModels(providerId, capability);
        } catch (error) {
          console.warn('[providers] 目录模型同步失败:', error);
        }
      }
    });
}
