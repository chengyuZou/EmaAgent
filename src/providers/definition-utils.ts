// 读取内置 Provider 预设；用户连接的最终协议与地址由 configuration.ts 解析。
import type {
  Capability,
  CapabilityProtocol,
  ProtocolFamily,
  ProviderCapabilityDefinition,
  ProviderDefinition,
} from './types.js';

export function listProviderCapabilities(definition: ProviderDefinition): Capability[] {
  return (Object.keys(definition.capabilities) as Capability[]).filter(
    (capability) => definition.capabilities[capability] !== undefined,
  );
}

export function getCapabilityDefinition(
  definition: ProviderDefinition,
  capability: Capability,
): ProviderCapabilityDefinition | undefined {
  return definition.capabilities[capability] as ProviderCapabilityDefinition | undefined;
}

export function providerSupportsCapability(
  definition: ProviderDefinition,
  capability: Capability,
): boolean {
  return getCapabilityDefinition(definition, capability) !== undefined;
}

export function defaultProtocolFor<TCapability extends Capability>(
  definition: ProviderDefinition,
  capability: TCapability,
): CapabilityProtocol<TCapability> | undefined {
  return getCapabilityDefinition(definition, capability)?.transports[0]?.protocol as
    | CapabilityProtocol<TCapability>
    | undefined;
}

export function presetBaseUrlFor(
  definition: ProviderDefinition,
  capability: Capability,
  protocol: ProtocolFamily,
): string | undefined {
  const capabilityDefinition = getCapabilityDefinition(definition, capability);
  if (!capabilityDefinition) return undefined;
  const transport = capabilityDefinition.transports.find(
    (candidate) => candidate.protocol === protocol,
  );
  if (!transport) return undefined;
  return transport.baseUrl ?? definition.connection.defaultBaseUrl;
}

export function modelsDevIdFor(
  definition: ProviderDefinition,
  capability: Capability,
): string | undefined {
  return getCapabilityDefinition(definition, capability)?.models?.modelsDevId;
}

export function staticModelsFor(
  definition: ProviderDefinition,
  capability: Capability,
): readonly string[] {
  return getCapabilityDefinition(definition, capability)?.models?.staticModels ?? [];
}

export function supportsLiveModelListing(
  definition: ProviderDefinition,
  capability: Capability,
): boolean {
  return getCapabilityDefinition(definition, capability)?.models?.supportsLiveListing === true;
}

export function requiresCredentials(definition: ProviderDefinition): boolean {
  return definition.connection.auth.type !== 'none' && definition.connection.auth.required;
}

export function isProtocolForCapability<TCapability extends Capability>(
  capability: TCapability,
  protocol: ProtocolFamily,
): protocol is CapabilityProtocol<TCapability> {
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
