// Provider Key 管理：按能力隔离的增删选与首次配置预填。
// V1 明文入库；listKeys 返回全文，掩码与 👁 是前端渲染规则，没有 reveal 端点。
import { Hono } from 'hono';
import { z } from 'zod';
import {
  PROVIDER_LIMITS,
  type ModelCapability,
  type Providers,
} from '@ema-agent/providers';
import { providerError } from './configs.js';

const capabilityParam = z.enum(['llm', 'embed', 'rerank', 'vision', 'tts', 'stt']);

const addKeyBody = z.object({
  capability: capabilityParam,
  keyValue: z.string().min(1).max(PROVIDER_LIMITS.apiKeyChars),
});

const selectKeyBody = z.object({
  capability: capabilityParam,
  keyId: z.string().min(1),
});

export interface ProviderKeysRouteDeps {
  readonly providers: Providers;
}

export function providerKeysRoute(deps: ProviderKeysRouteDeps): Hono {
  const app = new Hono();

  app.get('/:providerId/keys', context => {
    const capability = capabilityParam.safeParse(context.req.query('capability'));
    if (!capability.success) {
      return context.json({ error: 'invalid_capability' }, 400);
    }
    try {
      return context.json(deps.providers.listKeys(context.req.param('providerId'), capability.data));
    } catch (error) {
      return providerError(context, error);
    }
  });

  // 首次配置某能力时的预填：取全 provider 最近一把 key（硅基 LLM 的 key 一键带进 TTS）。
  app.get('/:providerId/keys/prefill', context => {
    const capability = capabilityParam.safeParse(context.req.query('capability'));
    if (!capability.success) {
      return context.json({ error: 'invalid_capability' }, 400);
    }
    const value = deps.providers.prefillKey(context.req.param('providerId'), capability.data);
    return context.json({ keyValue: value ?? null });
  });

  app.post('/:providerId/keys', async context => {
    const parsed = addKeyBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      return context.json(
        deps.providers.addKey(context.req.param('providerId'), parsed.data.capability, parsed.data.keyValue),
        201,
      );
    } catch (error) {
      return providerError(context, error);
    }
  });

  app.post('/:providerId/keys/select', async context => {
    const parsed = selectKeyBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      deps.providers.selectKey(context.req.param('providerId'), parsed.data.capability, parsed.data.keyId);
      return context.body(null, 204);
    } catch (error) {
      return providerError(context, error);
    }
  });

  app.delete('/:providerId/keys/:keyId', context => {
    const capability = capabilityParam.safeParse(context.req.query('capability'));
    if (!capability.success) {
      return context.json({ error: 'invalid_capability' }, 400);
    }
    try {
      deps.providers.deleteKey(
        context.req.param('providerId'),
        capability.data as ModelCapability,
        context.req.param('keyId'),
      );
      return context.body(null, 204);
    } catch (error) {
      return providerError(context, error);
    }
  });

  return app;
}
