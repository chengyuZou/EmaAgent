// Provider 探活：用一次真实的最小调用验证连接与凭据，并把结果交给 recordHealth。
// tts/stt 没有无输入的诚实探活——它们的功能验证是 capabilities.ts 的试听与转写。
import { Hono } from 'hono';
import { z } from 'zod';
import { createEmbedCall } from '@ema-agent/embed';
import { createLlmCall } from '@ema-agent/llm';
import {
  ProviderError,
  type ProviderModels,
  type Providers,
} from '@ema-agent/providers';
import { createRerankCall } from '@ema-agent/rerank';
import { providerError } from './configs.js';
import { jsonBody, paramValidator } from '../validate.js';

const PROBE_TIMEOUT_MS = 15_000;
/** 探活只支持有无输入即可验证连通性的能力。 */
const PROBE_CAPABILITIES = ['llm', 'embed', 'rerank'] as const;
type ProbeCapability = typeof PROBE_CAPABILITIES[number];

const probeParams = z.object({
  providerId: z.string().min(1),
  capability: z.enum(PROBE_CAPABILITIES),
});

const probeBody = z.object({
  modelId: z.string().min(1).optional(),
});

export interface ProviderHealthRouteDeps {
  readonly providers: Providers;
  readonly providerModels: ProviderModels;
}

export const providerHealthRoute = (deps: ProviderHealthRouteDeps) =>
  new Hono()
    // 缺省用池内第一个模型时也必须显式发 {}：契约一律声明，不吞真空 body。
    .post('/:providerId/probe/:capability', paramValidator(probeParams), jsonBody(probeBody), async context => {
      const { providerId, capability } = context.req.valid('param');
      const { modelId: requestedModelId } = context.req.valid('json');
      const startedAt = Date.now();
      try {
        const modelId = requestedModelId ?? firstPoolModelId(deps, providerId, capability);
        if (!modelId) {
          return context.json({ error: 'no_model', message: '先在该能力下添加一个模型再探活' }, 422);
        }
        await runProbe(deps.providers, providerId, capability, modelId, AbortSignal.timeout(PROBE_TIMEOUT_MS));
        deps.providers.recordHealth(providerId, capability, {
          capability,
          status: 'ok',
          lastProbedAt: Date.now(),
          latencyMs: Date.now() - startedAt,
          lastError: null,
        });
        return context.json({ ok: true, latencyMs: Date.now() - startedAt });
      } catch (error) {
        if (error instanceof ProviderError) return providerError(context, error);
        const message = error instanceof Error ? error.message : String(error);
        deps.providers.recordHealth(providerId, capability, {
          capability,
          status: 'failed',
          lastProbedAt: Date.now(),
          latencyMs: Date.now() - startedAt,
          lastError: message,
        });
        return context.json({ ok: false, error: message }, 502);
      }
    });

function firstPoolModelId(
  deps: ProviderHealthRouteDeps,
  providerId: string,
  capability: ProbeCapability,
): string | undefined {
  return deps.providerModels.listByProvider(providerId, capability)[0]?.modelId;
}

/** 一次真实最小调用：任何协议错误都上抛给 recordHealth，不做假成功。 */
async function runProbe(
  providers: Providers,
  providerId: string,
  capability: ProbeCapability,
  modelId: string,
  signal: AbortSignal,
): Promise<void> {
  // 每个分支用字面量能力解析连接，泛型收窄到该能力的连接类型。
  switch (capability) {
    case 'llm': {
      const callLlm = createLlmCall(providers.resolveConnection(providerId, 'llm'), modelId);
      // 消费至流自然结束；任何协议层错误都在迭代中抛出。
      for await (const event of callLlm({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        maxOutputTokens: 1,
        signal,
      })) {
        void event;
      }
      return;
    }
    case 'embed':
      await createEmbedCall(providers.resolveConnection(providerId, 'embed'), modelId)({ texts: ['ping'], signal });
      return;
    case 'rerank':
      await createRerankCall(providers.resolveConnection(providerId, 'rerank'), modelId)({
        query: 'ping',
        documents: ['a', 'b'],
        signal,
      });
      return;
  }
}
