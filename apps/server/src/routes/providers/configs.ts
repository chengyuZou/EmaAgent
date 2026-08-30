// Provider 控制面：内置种子与自建同表同构的 CRUD；能力档位经 update 的 capability 单量修改。
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  PROTOCOLS,
  PROVIDER_LIMITS,
  ProviderError,
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
});

const createProviderBody = z.object({
  id: z.string().min(1).max(PROVIDER_LIMITS.idChars),
  name: z.string().min(1).max(PROVIDER_LIMITS.nameChars),
  iconId: z.string().optional(),
  authType: z.enum(['none', 'bearer']),
  /** one key per provider；bearer 未提供时先建行。 */
  key: z.string().min(1).max(PROVIDER_LIMITS.apiKeyChars).optional(),
  capabilities: z.array(capabilityInputSchema).default([]),
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
}

export const providerConfigsRoute = (deps: ProviderConfigsRouteDeps) =>
  new Hono()
    .get('/', context => context.json(deps.providers.list()))
    .post('/', jsonBody(createProviderBody), async context => {
      try {
        return context.json(deps.providers.create(context.req.valid('json')), 201);
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
        return context.json(deps.providers.update(context.req.param('providerId'), context.req.valid('json')));
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
      return context.json({ error: error.code, message: error.message, conflicts: error.conflicts }, 409);
    default:
      return context.json({ error: error.code, message: error.message }, 422);
  }
}
