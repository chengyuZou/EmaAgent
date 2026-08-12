// 汇总 Ema 内置供应商预设，并提供按身份和能力查询的唯一目录入口；
// 同时收纳对单个预设的纯读取函数（控制面与设置页共用）。
import type {
  ModelCapability,
  ModelCapabilityProtocol,
  Protocol,
  Provider,
  ProviderCapability,
} from './types.js';
import { provider as anthropic } from './providers/anthropic/index.js';
import { provider as dashscope } from './providers/dashscope/index.js';
import { provider as deepseek } from './providers/deepseek/index.js';
import { provider as fireworks } from './providers/fireworks/index.js';
import { provider as gemini } from './providers/gemini/index.js';
import { provider as gptSovits } from './providers/gpt-sovits/index.js';
import { provider as groq } from './providers/groq/index.js';
import { provider as jina } from './providers/jina/index.js';
import { provider as lmstudio } from './providers/lmstudio/index.js';
import { provider as mistral } from './providers/mistral/index.js';
import { provider as moonshot } from './providers/moonshot/index.js';
import { provider as ollama } from './providers/ollama/index.js';
import { provider as openai } from './providers/openai/index.js';
import { provider as openrouter } from './providers/openrouter/index.js';
import { provider as perplexity } from './providers/perplexity/index.js';
import { provider as siliconflow } from './providers/siliconflow/index.js';
import { provider as together } from './providers/together/index.js';
import { provider as xai } from './providers/xai/index.js';
import { provider as zhipu } from './providers/zhipu/index.js';

// 顺序同时用于设置页展示；新增供应商时应显式选择位置，不能依赖文件系统遍历顺序。
const BUILTIN_PROVIDERS: readonly Provider[] = [
  openai,
  anthropic,
  gemini,
  deepseek,
  moonshot,
  zhipu,
  openrouter,
  groq,
  mistral,
  xai,
  perplexity,
  together,
  fireworks,
  ollama,
  lmstudio,
  siliconflow,
  jina,
  dashscope,
  gptSovits,
];

export const PROVIDERS_BY_ID: Readonly<Record<string, Provider>> =
  Object.freeze(Object.fromEntries(BUILTIN_PROVIDERS.map((provider) => [provider.id, provider])));

export function getProvider(id: string): Provider | undefined {
  return PROVIDERS_BY_ID[id];
}

export function listProviders(): readonly Provider[] {
  return BUILTIN_PROVIDERS;
}

export function providersWithCapability(capability: ModelCapability): readonly Provider[] {
  return BUILTIN_PROVIDERS.filter((provider) => providerSupportsCapability(provider, capability));
}

export function listProviderIds(): readonly string[] {
  return BUILTIN_PROVIDERS.map((provider) => provider.id);
}

/** 目录 get/list 的纯函数绑定，供控制面注入与现有调用点使用。 */
export const providerCatalog = {
  get: getProvider,
  list: listProviders,
};

// ── 单个预设的纯读取 ──────────────────────────────────────────────────────────

export function listProviderCapabilities(provider: Provider): ModelCapability[] {
  return (Object.keys(provider.capabilities) as ModelCapability[]).filter(
    (capability) => provider.capabilities[capability] !== undefined,
  );
}

export function getProviderCapability(
  provider: Provider,
  capability: ModelCapability,
): ProviderCapability | undefined {
  return provider.capabilities[capability] as ProviderCapability | undefined;
}

export function providerSupportsCapability(
  provider: Provider,
  capability: ModelCapability,
): boolean {
  return getProviderCapability(provider, capability) !== undefined;
}

export function defaultProtocolFor<TCapability extends ModelCapability>(
  provider: Provider,
  capability: TCapability,
): ModelCapabilityProtocol<TCapability> | undefined {
  return getProviderCapability(provider, capability)?.protocols[0]?.protocol as
    | ModelCapabilityProtocol<TCapability>
    | undefined;
}

export function presetBaseUrlFor(
  provider: Provider,
  capability: ModelCapability,
  protocol: Protocol,
): string | undefined {
  const capabilityPreset = getProviderCapability(provider, capability);
  if (!capabilityPreset) return undefined;
  const option = capabilityPreset.protocols.find(
    (candidate) => candidate.protocol === protocol,
  );
  if (!option) return undefined;
  return option.baseUrl ?? provider.connection.defaultBaseUrl;
}

export function modelsDevIdFor(
  provider: Provider,
  capability: ModelCapability,
): string | undefined {
  return getProviderCapability(provider, capability)?.catalog?.modelsDevId;
}

export function staticModelsFor(
  provider: Provider,
  capability: ModelCapability,
): readonly string[] {
  return getProviderCapability(provider, capability)?.catalog?.staticModels ?? [];
}

export function supportsLiveModelListing(
  provider: Provider,
  capability: ModelCapability,
): boolean {
  return getProviderCapability(provider, capability)?.catalog?.supportsLiveListing === true;
}

export function requiresCredentials(provider: Provider): boolean {
  return provider.connection.auth.type !== 'none' && provider.connection.auth.required;
}

export function isProtocolForCapability<TCapability extends ModelCapability>(
  capability: TCapability,
  protocol: Protocol,
): protocol is ModelCapabilityProtocol<TCapability> {
  switch (capability) {
    case 'llm':
      return protocol === 'openai-llm'
        || protocol === 'openai-responses-llm'
        || protocol === 'anthropic-llm'
        || protocol === 'gemini-llm';
    case 'embed':
      return protocol === 'openai-embed' || protocol === 'gemini-embed';
    case 'rerank':
      return protocol === 'cohere-rerank';
    case 'vision':
      return protocol === 'openai-vision'
        || protocol === 'anthropic-vision'
        || protocol === 'gemini-vision';
    case 'tts':
      return protocol === 'openai-tts'
        || protocol === 'dashscope-tts'
        || protocol === 'gpt-sovits-tts';
    case 'stt':
      return protocol === 'openai-stt';
  }
}
