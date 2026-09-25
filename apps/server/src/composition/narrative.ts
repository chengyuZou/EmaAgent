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
  /** Rust 每次报告实际端口时替换当次 Bridge，并推送进程级 Embedding 连接。 */
  attach(port: number): Promise<void>;
  /** 先断开新 Turn 的入口，再请求当前 Python 进程退出。 */
  shutdown(): Promise<boolean>;
  /** Rust 确认 Python 意外退出时清除旧 Client。 */
  detach(): void;
  /** Turn 开始时冻结当前 Bridge；不在场时返回 undefined。 */
  currentClient(): NarrativeClient | undefined;
  /** Turn 开始时冻结的当次 Narrative LLM 连接；未绑定或协议不支持时返回 undefined。 */
  resolveNarrativeLlm(): NarrativeLlmConnection | undefined;
}

export function openNarrative(
  providers: Providers,
  providerModels: ProviderModels,
  modelBindings: ModelBindings,
): NarrativeComposition {
  const secret = process.env['EMA_SHARED_SECRET'];
  let narrative: NarrativeClient | undefined;

  const configureNarrativeBridge = async (client: NarrativeClient): Promise<void> => {
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
      const ok = await client.configure(payload);
      if (!ok) console.warn('[narrative-bridge] 配置推送失败——Narrative 能力降级');
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
    }
  };

  const attach = async (port: number): Promise<void> => {
    const client = new NarrativeClient({
      baseUrl: `http://127.0.0.1:${port}`,
      ...(secret ? { secret } : {}),
    });
    await configureNarrativeBridge(client);
    narrative = client;
  };

  const shutdown = async (): Promise<boolean> => {
    const client = narrative;
    if (!client) return false;
    narrative = undefined;
    const accepted = await client.shutdown();
    if (!accepted) narrative = client;
    return accepted;
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

  return {
    attach,
    shutdown,
    detach: () => { narrative = undefined; },
    currentClient: () => narrative,
    resolveNarrativeLlm,
  };
}
