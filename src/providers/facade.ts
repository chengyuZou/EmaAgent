// 作为 Provider 静态目录的唯一业务入口，统一提供定义、能力、协议、地址和模型来源查询。
import {
  listProviderCapabilities,
  modelSourcesFor,
  protocolsForCapability,
  providerSupportsCapability,
  resolveBaseUrl,
} from './definition-utils.js';
import {
  getProviderDefinition,
  listProviderDefinitionIds,
  listProviderDefinitions,
  providersWithCapability,
} from './registry.js';
import type {
  Capability,
  ProtocolFamily,
  ProviderDefinition,
  ProviderModelSource,
} from './types.js';

export class ProviderCatalogFacade {
  get(id: string): ProviderDefinition | undefined {
    return getProviderDefinition(id);
  }

  list(): readonly ProviderDefinition[] {
    return listProviderDefinitions();
  }

  ids(): readonly string[] {
    return listProviderDefinitionIds();
  }

  listByCapability(capability: Capability): readonly ProviderDefinition[] {
    return providersWithCapability(capability);
  }

  capabilitiesOf(definition: ProviderDefinition): readonly Capability[] {
    return listProviderCapabilities(definition);
  }

  supports(definition: ProviderDefinition, capability: Capability): boolean {
    return providerSupportsCapability(definition, capability);
  }

  protocolsOf(
    definition: ProviderDefinition,
    capability: Capability,
  ): readonly ProtocolFamily[] {
    return protocolsForCapability(definition, capability);
  }

  defaultBaseUrlFor(
    definition: ProviderDefinition,
    capability: Capability,
    protocol?: ProtocolFamily,
  ): string | undefined {
    return resolveBaseUrl(definition, capability, protocol);
  }

  modelSourcesOf(
    definition: ProviderDefinition,
    capability: Capability,
  ): readonly ProviderModelSource[] {
    return modelSourcesFor(definition, capability);
  }
}

export const providerCatalog = new ProviderCatalogFacade();
