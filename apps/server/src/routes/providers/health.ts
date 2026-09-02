import { Hono } from 'hono';
import { z } from 'zod';
import { createEmbedCall } from '@ema-agent/embed';
import { createLlmCall } from '@ema-agent/llm';
import {
  ProviderError,
  type ModelsDevCatalog,
  type ProviderModels,
  type Providers,
} from '@ema-agent/providers';
import { createRerankCall } from '@ema-agent/rerank';
import { providerError } from './configs.js';
import { jsonBody, paramValidator } from '../validate.js';

const PROBE_TIMEOUT_MS = 15_000;
/** 探活只支持有无输入即可验证连通性的能力；vision 与 llm 同协议族，文本 ping 即可。 */
const PROBE_CAPABILITIES = ['llm', 'embed', 'rerank', 'vision'] as const;
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
  readonly modelCatalog: ModelsDevCatalog;
}

export const providerHealthRoute = (deps: ProviderHealthRouteDeps) =>
  new Hono()
    // tts/stt 没有无输入的诚实探活——它们的功能验证是 capabilities.ts 的试听与转写
    .post('/:providerId/probe/:capability', paramValidator(probeParams), jsonBody(probeBody), async context => {
      const { providerId, capability } = context.req.valid('param');
      const { modelId: requestedModelId } = context.req.valid('json');
      const startedAt = Date.now();
      try {
        const modelId = requestedModelId ?? firstPingSubject(deps, providerId, capability);
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
        const message = probeErrorMessage(error);
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

/**
 * 探活错误归一：上游 SDK 的错误消息常带完整响应体（`401 {"error":{"message":"..."}}`），
 * 能提取人话就只留"状态 · 人话"；提取不出用原文（不截断，排查要全文）。
 */
function probeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const body = JSON.parse(raw.slice(jsonStart)) as { error?: { message?: unknown } };
      if (typeof body.error?.message === 'string') {
        const status = raw.slice(0, jsonStart).trim();
        return status ? `${status} ${body.error.message}` : body.error.message;
      }
    } catch {
      // 不是 JSON 响应体，用原文
    }
  }
  return raw;
}

/** Ping 主体：池内第一行；llm/vision 池空时用目录第一个模型 id（不落行，纯连通性验证）。
 * embed/rerank 无目录覆盖：池空必须手填，如实 no_model。
 */
function firstPingSubject(
  deps: ProviderHealthRouteDeps,
  providerId: string,
  capability: ProbeCapability,
): string | undefined {
  const row = deps.providerModels.listByProvider(providerId, capability)[0]?.modelId;
  if (row) return row;
  if (capability !== 'llm' && capability !== 'vision') return undefined;
  const modelsDevId = deps.providers.get(providerId).capabilities
    .find(c => c.capability === capability)?.modelsDevId;
  if (!modelsDevId) return undefined;
  return capability === 'llm'
    ? deps.modelCatalog.listLlmModelIds(modelsDevId)[0]
    : deps.modelCatalog.listVisionModelIds(modelsDevId)[0];
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
    case 'vision': {
      // vision 是带图片输入的 LLM：复用 LLM 协议族发文本 ping，但解析 vision 能力自己的档位。
      const callLlm = createLlmCall(providers.resolveConnection(providerId, 'vision'), modelId);
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
