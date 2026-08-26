// Provider Key 管理：按能力隔离的增删选与首次配置预填。
// V1 明文入库；listKeys 返回全文，掩码与 👁 是前端渲染规则，没有 reveal 端点。
import { Hono } from 'hono';
import { z } from 'zod';
import {
  PROVIDER_LIMITS,
  type Providers,
} from '@ema-agent/providers';
import { providerError } from './configs.js';
import { jsonBody, queryValidator } from '../validate.js';

const capabilityParam = z.enum(['llm', 'embed', 'rerank', 'vision', 'tts', 'stt']);

const capabilityQuery = z.object({
  capability: capabilityParam,
});

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

export const providerKeysRoute = (deps: ProviderKeysRouteDeps) =>
  new Hono()
    .get('/:providerId/keys', queryValidator(capabilityQuery), context => {
      const { capability } = context.req.valid('query');
      try {
        return context.json(deps.providers.listKeys(context.req.param('providerId'), capability));
      } catch (error) {
        return providerError(context, error);
      }
    })
    // 首次配置某能力时的预填：取全 provider 最近一把 key（硅基 LLM 的 key 一键带进 TTS）。
    .get('/:providerId/keys/prefill', queryValidator(capabilityQuery), context => {
      const { capability } = context.req.valid('query');
      const value = deps.providers.prefillKey(context.req.param('providerId'), capability);
      return context.json({ keyValue: value ?? null });
    })
    .post('/:providerId/keys', jsonBody(addKeyBody), async context => {
      const { capability, keyValue } = context.req.valid('json');
      try {
        return context.json(
          deps.providers.addKey(context.req.param('providerId'), capability, keyValue),
          201,
        );
      } catch (error) {
        return providerError(context, error);
      }
    })
    .post('/:providerId/keys/select', jsonBody(selectKeyBody), async context => {
      const { capability, keyId } = context.req.valid('json');
      try {
        deps.providers.selectKey(context.req.param('providerId'), capability, keyId);
        return context.body(null, 204);
      } catch (error) {
        return providerError(context, error);
      }
    })
    .delete('/:providerId/keys/:keyId', queryValidator(capabilityQuery), context => {
      const { capability } = context.req.valid('query');
      try {
        deps.providers.deleteKey(
          context.req.param('providerId'),
          capability,
          context.req.param('keyId'),
        );
        return context.body(null, 204);
      } catch (error) {
        return providerError(context, error);
      }
    });
