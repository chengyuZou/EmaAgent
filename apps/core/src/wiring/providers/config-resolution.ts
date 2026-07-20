// 解析数据库中的能力级 Provider 配置，并用静态定义补齐未覆盖的协议与地址。
import type { ProviderCapabilityConfigRow, ProviderConfigRow } from '@ema-agent/storage';
import {
  protocolsForCapability,
  resolveBaseUrl,
  type Capability,
  type ProtocolFamily,
  type ProviderDefinition,
} from '@ema-agent/provider';

export function capabilityConfigFor(
  row: ProviderConfigRow,
  capability: Capability,
): ProviderCapabilityConfigRow | undefined {
  return row.capabilities.find(
    (candidate) => candidate.capability === capability && candidate.enabled === 1,
  );
}

export function selectedProtocolFor(
  definition: ProviderDefinition,
  capability: Capability,
  config: ProviderCapabilityConfigRow,
): ProtocolFamily | undefined {
  const choices = protocolsForCapability(definition, capability);
  return config.protocol && choices.includes(config.protocol)
    ? config.protocol
    : choices[0];
}

export function configuredBaseUrlFor(
  definition: ProviderDefinition,
  capability: Capability,
  config: ProviderCapabilityConfigRow,
  protocol: ProtocolFamily,
): string | undefined {
  return config.base_url ?? resolveBaseUrl(definition, capability, protocol);
}
