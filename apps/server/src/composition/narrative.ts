// Narrative 一族：Bridge 客户端、进程级 Embedding 配置推送与当次 LLM 连接解析。
import {
  NarrativeClient,
  type NarrativeBridgeConfigureRequest,
  type NarrativeLlmConnection,
} from '@ema-agent/narrative';
import {
  ProviderError,
  type ModelBindings,
  type ProviderModels,
  type Providers,
} from '@ema-agent/providers';

export interface NarrativeComposition {
  /** EMA_NARRATIVE_BRIDGE_URL 缺失时为 null：Bridge 不在场，Narrative 能力整体降级。 */
  readonly narrative: NarrativeClient | null;
  /**
   * 把 lightrag-embed 绑定解析出的进程级 Embedding 连接推给 Bridge；启动时调用一次。
   * Bridge 不在场、绑定未配置或协议不支持都降级为不推送，不阻断主链路。
   */
  configureNarrativeBridge(): Promise<void>;
  /** 令 Bridge 优雅退出（narrative.bridgeEnabled 关闭时）；Bridge 不在场为 no-op。 */
  shutdownNarrativeBridge(): Promise<void>;
  /** Turn 开始时冻结的当次 Narrative LLM 连接；未绑定或协议不支持时返回 undefined。 */
  resolveNarrativeLlm(): NarrativeLlmConnection | undefined;
}

export function openNarrative(
  providers: Providers,
  providerModels: ProviderModels,
  modelBindings: ModelBindings,
): NarrativeComposition {
  const baseUrl = process.env['EMA_NARRATIVE_BRIDGE_URL'];
  const secret = process.env['EMA_SHARED_SECRET'];
  const narrative = baseUrl
    ? new NarrativeClient({ baseUrl, ...(secret ? { secret } : {}) })
    : null;

  const configureNarrativeBridge = async (): Promise<void> => {
    if (!narrative) return;
    const embedBinding = modelBindings.get('lightrag-embed');
    if (!embedBinding) return;
    // 绑定只能指向已启用模型；行缺失说明不变量被破坏，跳过并告警而不是编一个 dim。
    const model = providerModels.get(embedBinding.providerId, 'embed', embedBinding.modelId);
    if (!model || model.capability !== 'embed') {
      console.warn(`[narrative-bridge] lightrag-embed 绑定的模型行缺失: ${embedBinding.providerId}/${embedBinding.modelId}`);
      return;
    }
    try {
      const connection = providers.resolveConnection(embedBinding.providerId, 'embed');
      // Bridge 侧只实现了 openai-embed 协议族。
      if (connection.protocol !== 'openai-embed') {
        console.warn(`[narrative-bridge] embed 协议 [${connection.protocol}] 不支持`);
        return;
      }
      const payload: NarrativeBridgeConfigureRequest = {
        embed: {
          baseUrl: connection.baseUrl,
          ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
          modelId: embedBinding.modelId,
          dim: model.dim,
        },
      };
      const ok = await narrative.configure(payload);
      if (!ok) console.warn('[narrative-bridge] 配置推送失败——Narrative 能力降级');
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
    }
  };

  const shutdownNarrativeBridge = async (): Promise<void> => {
    if (!narrative) return;
    const ok = await narrative.shutdown();
    if (!ok) console.warn('[narrative-bridge] 关闭请求未生效（Bridge 可能已退出）');
  };

  const resolveNarrativeLlm = (): NarrativeLlmConnection | undefined => {
    const binding = modelBindings.get('lightrag-llm');
    if (!binding) return undefined;
    try {
      const connection = providers.resolveConnection(binding.providerId, 'llm');
      // Bridge 只实现 OpenAI chat completions 调用；其余 LLM 协议族不支持。
      if (connection.protocol !== 'openai-llm') {
        console.warn(`[narrative-bridge] llm 协议 [${connection.protocol}] 不支持`);
        return undefined;
      }
      return {
        baseUrl: connection.baseUrl,
        ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
        modelId: binding.modelId,
      };
    } catch (err) {
      if (err instanceof ProviderError) return undefined;
      throw err;
    }
  };

  return { narrative, configureNarrativeBridge, shutdownNarrativeBridge, resolveNarrativeLlm };
}
