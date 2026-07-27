// 校验 Provider 能力级写入参数，并在 API 输入与 Storage 行结构之间做显式转换。
import type {
  ProviderCapabilityConfigInput,
  ProviderConfigRow,
} from '@ema-agent/storage';
import {
  providerSupportsCapability,
  protocolsForCapability,
  type Capability,
  type ProviderDefinition,
} from '@ema-agent/provider';

export type ProviderCapabilityValidationResult =
  | { ok: true; value: ProviderCapabilityConfigInput[] }
  | { ok: false; message: string };

export function validateProviderCapabilityConfigs(
  definition: ProviderDefinition,
  requested: ProviderCapabilityConfigInput[],
): ProviderCapabilityValidationResult {
  if (requested.length === 0) {
    return { ok: false, message: '至少需要启用一项 Provider 能力' };
  }
  const seen = new Set<Capability>();
  for (const config of requested) {
    if (seen.has(config.capability)) {
      return { ok: false, message: `能力 ${config.capability} 重复` };
    }
    seen.add(config.capability);
    if (!providerSupportsCapability(definition, config.capability)) {
      return { ok: false, message: `${definition.name} 不支持 ${config.capability}` };
    }
    if (config.protocol) {
      const choices = protocolsForCapability(definition, config.capability);
      if (!choices.includes(config.protocol)) {
        return { ok: false, message: `${config.capability} 不支持协议 ${config.protocol}` };
      }
    }
    if (config.embeddingRevision && config.capability !== 'embed') {
      return { ok: false, message: 'embeddingRevision 仅适用于 Embed 能力' };
    }
  }
  return { ok: true, value: requested };
}

export function capabilityInputsFromProviderRow(
  row: ProviderConfigRow,
): ProviderCapabilityConfigInput[] {
  return row.capabilities.map((capability) => ({
    capability: capability.capability,
    protocol: capability.protocol,
    baseUrl: capability.base_url,
    embeddingRevision: capability.embedding_revision,
    enabled: capability.enabled === 1,
  }));
}
