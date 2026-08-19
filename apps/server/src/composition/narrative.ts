// Narrative 一族：Bridge 客户端、URL 发现与 LightRAG 模型配置推送。
import fs from 'node:fs';
import path from 'node:path';
import {
  NarrativeClient,
  type NarrativeBridgeConfigurePayload,
} from '@ema-agent/narrative';
import {
  ProviderError,
  type ModelBindings,
  type ProviderModels,
  type Providers,
} from '@ema-agent/providers';
import { profileDir } from '../platform/paths.js';

/**
 * 调用时（而非进程启动时）解析 Bridge 地址：
 * 1. EMA_NARRATIVE_BRIDGE_URL 环境变量——开发/CI 全量覆盖；
 * 2. `{profileDir}/narrative-bridge.port`——Bridge 启动时写入；
 * 3. 回退 http://127.0.0.1:7421。
 */
export function resolveNarrativeBridgeUrl(): string {
  if (process.env['EMA_NARRATIVE_BRIDGE_URL']) {
    return process.env['EMA_NARRATIVE_BRIDGE_URL'];
  }
  const portFile = path.join(profileDir(), 'narrative-bridge.port');
  try {
    const port = fs.readFileSync(portFile, 'utf8').trim();
    if (port) return `http://127.0.0.1:${port}`;
  } catch { /* Bridge 尚未启动，继续使用默认端口。 */ }
  return 'http://127.0.0.1:7421';
}

export interface NarrativeComposition {
  readonly narrative: NarrativeClient;
  /**
   * 把 lightrag-llm/lightrag-embed 绑定推给 Bridge；启动时与这两个绑定变更后调用。
   * Bridge 不在场或绑定未配置都降级为不推送，不阻断主链路。
   */
  configureNarrativeBridge(): Promise<void>;
}

export function openNarrative(
  providers: Providers,
  providerModels: ProviderModels,
  modelBindings: ModelBindings,
): NarrativeComposition {
  const narrative = new NarrativeClient({ baseUrl: resolveNarrativeBridgeUrl() });

  const configureNarrativeBridge = async (): Promise<void> => {
    narrative.updateBaseUrl(resolveNarrativeBridgeUrl());
    const payload: NarrativeBridgeConfigurePayload = { llm: null, embed: null };

    const llmBinding = modelBindings.get('lightrag-llm');
    if (llmBinding) {
      try {
        const connection = providers.resolveConnection(llmBinding.providerId, 'llm');
        payload.llm = {
          apiKey: connection.apiKey ?? '',
          baseUrl: connection.baseUrl,
          model: llmBinding.modelId,
        };
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
      }
    }

    const embedBinding = modelBindings.get('lightrag-embed');
    if (embedBinding) {
      // 绑定只能指向已启用模型；行缺失说明不变量被破坏，跳过并告警而不是编一个 dim。
      const model = providerModels.get(embedBinding.providerId, 'embed', embedBinding.modelId);
      if (!model || model.capability !== 'embed') {
        console.warn(`[narrative-bridge] lightrag-embed 绑定的模型行缺失: ${embedBinding.providerId}/${embedBinding.modelId}`);
      } else {
        try {
          const connection = providers.resolveConnection(embedBinding.providerId, 'embed');
          // Bridge 侧只实现了 openai-embed 协议族。
          if (connection.protocol === 'openai-embed') {
            payload.embed = {
              protocol: 'openai-embed',
              apiKey: connection.apiKey ?? '',
              baseUrl: connection.baseUrl,
              model: embedBinding.modelId,
              dim: model.dim,
            };
          } else {
            console.warn(`[narrative-bridge] embed 协议 [${connection.protocol}] 不支持`);
          }
        } catch (err) {
          if (!(err instanceof ProviderError)) throw err;
        }
      }
    }

    const ok = await narrative.configure(payload);
    if (!ok) console.warn('[narrative-bridge] 不可用——Narrative 能力降级');
  };

  return { narrative, configureNarrativeBridge };
}
