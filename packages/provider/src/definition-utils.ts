// 解析供应商能力、协议、模型来源和最终连接地址，避免调用方猜测定义结构。
import type {
  Capability,
  ProtocolFamily,
  ProviderCapabilityDefinition,
  ProviderDefinition,
  ProviderModelSource,
} from './types.js';

export function listProviderCapabilities(definition: ProviderDefinition): Capability[] {
  return (Object.keys(definition.capabilities) as Capability[]).filter(
    (capability) => definition.capabilities[capability] !== undefined,
  );
}

export function providerSupportsCapability(
  definition: ProviderDefinition,
  capability: Capability,
): boolean {
  return definition.capabilities[capability] !== undefined;
}

export function getCapabilityDefinition(
  definition: ProviderDefinition,
  capability: Capability,
): ProviderCapabilityDefinition | undefined {
  return definition.capabilities[capability] as ProviderCapabilityDefinition | undefined;
}

export function protocolsForCapability(
  definition: ProviderDefinition,
  capability: Capability,
): ProtocolFamily[] {
  return getCapabilityDefinition(definition, capability)?.transports.map(
    (transport) => transport.protocol,
  ) ?? [];
}

export function resolveBaseUrl(
  definition: ProviderDefinition,
  capability: Capability,
  protocol?: ProtocolFamily,
): string | undefined {
  const transports = getCapabilityDefinition(definition, capability)?.transports ?? [];
  const selected = protocol === undefined
    ? transports[0]
    : transports.find((transport) => transport.protocol === protocol);
  return selected?.baseUrl ?? definition.connection.defaultBaseUrl;
}

export function modelSourcesFor(
  definition: ProviderDefinition,
  capability: Capability,
): readonly ProviderModelSource[] {
  return getCapabilityDefinition(definition, capability)?.models?.sources ?? [];
}

export function modelsDevIdFor(
  definition: ProviderDefinition,
  capability: Capability,
): string | undefined {
  const source = modelSourcesFor(definition, capability).find(
    (candidate): candidate is Extract<ProviderModelSource, { type: 'models-dev' }> =>
      candidate.type === 'models-dev',
  );
  return source?.providerId;
}

export function staticModelsFor(
  definition: ProviderDefinition,
  capability: Capability,
): readonly string[] {
  return modelSourcesFor(definition, capability).flatMap((source) =>
    source.type === 'static' ? [...source.models] : [],
  );
}

export function requiresCredentials(definition: ProviderDefinition): boolean {
  return definition.connection.auth.type !== 'none'
    && definition.connection.auth.required;
}

export function isLlmProtocol(protocol: ProtocolFamily | undefined): protocol is Extract<ProtocolFamily, `${string}-llm`> {
  return protocol === 'openai-llm'
    || protocol === 'openai-responses-llm'
    || protocol === 'anthropic-llm'
    || protocol === 'gemini-llm';
}

export function isEmbedProtocol(protocol: ProtocolFamily | undefined): protocol is Extract<ProtocolFamily, `${string}-embed`> {
  return protocol === 'openai-embed' || protocol === 'gemini-embed';
}

export function isRerankProtocol(protocol: ProtocolFamily | undefined): protocol is Extract<ProtocolFamily, `${string}-rerank`> {
  return protocol === 'cohere-rerank';
}

export function isVisionProtocol(protocol: ProtocolFamily | undefined): protocol is Extract<ProtocolFamily, `${string}-vision`> {
  return protocol === 'openai-vision'
    || protocol === 'anthropic-vision'
    || protocol === 'gemini-vision';
}

export function isTtsProtocol(protocol: ProtocolFamily | undefined): protocol is Extract<ProtocolFamily, `${string}-tts`> {
  return protocol === 'openai-tts'
    || protocol === 'dashscope-tts'
    || protocol === 'gpt-sovits-tts';
}

export function isSttProtocol(protocol: ProtocolFamily | undefined): protocol is Extract<ProtocolFamily, `${string}-stt`> {
  return protocol === 'openai-stt';
}
