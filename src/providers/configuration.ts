// 管理 Provider 配置生命周期，统一能力校验、密钥操作、绑定冲突和运行时刷新。
import {
  listProviderCapabilities,
  providerSupportsCapability,
  protocolsForCapability,
} from './definition-utils.js';
import { ProviderConfigurationError } from './errors.js';
import {
  MODEL_BINDING_CAPABILITIES,
  type ModelBindingStore,
  type ResolvedModelBinding,
} from './modelBindings.js';
import type {
  Capability,
  ProtocolFamily,
  ProviderCredentialOperation,
  ProviderDefinition,
} from './types.js';

export interface ProviderCapabilityConfiguration {
  capability: Capability;
  /** 留空（undefined/null）表示使用 Provider 定义中该能力的首选协议。 */
  protocol?: ProtocolFamily | null;
  /** 留空表示使用 Provider 定义或协议声明的默认地址。 */
  baseUrl?: string | null;
  /** 仅 Embed 使用：区分同名模型的向量空间版本（换维度/换代时避免索引混用）。 */
  embeddingRevision?: string | null;
  enabled?: boolean;
}

export interface ConfiguredProvider {
  id: string;
  definitionId: string;
  displayName: string;
  /** 只允许在本机进程内短暂存在；HTTP 默认只投影 hasApiKey。 */
  credential: string | null;
  enabled: boolean;
  capabilities: ProviderCapabilityConfiguration[];
}

export interface ProviderHealthSnapshot {
  status: 'ok' | 'failed' | 'unknown';
  lastProbedAt: number | null;
  latencyMs: number | null;
  lastError: string | null;
  consecutiveFails: number;
}

export interface ProviderConfigurationSnapshot {
  config: ConfiguredProvider;
  health: ProviderHealthSnapshot | null;
}

export interface SaveProviderConfiguration {
  id: string;
  definitionId: string;
  displayName: string;
  /** undefined 保留，null 清空，string 替换。 */
  credential?: string | null;
  enabled: boolean;
  capabilities: ProviderCapabilityConfiguration[];
}

export interface ProviderConfigurationStore {
  get(id: string): ConfiguredProvider | undefined;
  getWithHealth(id: string): ProviderConfigurationSnapshot | undefined;
  listWithHealth(): ProviderConfigurationSnapshot[];
  save(input: SaveProviderConfiguration): void;
  delete(id: string): void;
}

export interface ProviderConfigurationRuntime {
  refresh(): void;
}

export interface ProviderDefinitionCatalog {
  get(id: string): ProviderDefinition | undefined;
  list(): readonly ProviderDefinition[];
}

export interface CreateProviderConfiguration {
  definitionId: string;
  displayName?: string;
  credential?: string;
  enabled: boolean;
  capabilities?: ProviderCapabilityConfiguration[];
}

export interface UpdateProviderConfiguration {
  displayName?: string;
  credential?: ProviderCredentialOperation;
  enabled?: boolean;
  capability?: ProviderCapabilityConfiguration;
}

export class ProviderConfiguration {
  constructor(
    private readonly definitions: ProviderDefinitionCatalog,
    private readonly store: ProviderConfigurationStore,
    private readonly bindings: Pick<ModelBindingStore, 'listByProviderConfig'>,
    private readonly runtime: ProviderConfigurationRuntime,
    private readonly createId: () => string,
  ) {}

  definitionsList(): readonly ProviderDefinition[] {
    return this.definitions.list();
  }

  definition(id: string): ProviderDefinition | undefined {
    return this.definitions.get(id);
  }

  list(): ProviderConfigurationSnapshot[] {
    return this.store.listWithHealth();
  }

  get(id: string): ProviderConfigurationSnapshot {
    const snapshot = this.store.getWithHealth(id);
    if (!snapshot) throw new ProviderConfigurationError('not_found', 'Provider 不存在');
    return snapshot;
  }

  revealCredential(id: string): string {
    const config = this.store.get(id);
    if (!config) throw new ProviderConfigurationError('not_found', 'Provider 不存在');
    return config.credential ?? '';
  }

  create(input: CreateProviderConfiguration): ConfiguredProvider {
    const id = this.createId();
    const definition = this.requireDefinition(input.definitionId);
    const requested = input.capabilities
      ?? listProviderCapabilities(definition).map((capability) => ({ capability }));
    const capabilities = validateCapabilityConfigurations(definition, requested);

    this.store.save({
      id,
      definitionId: input.definitionId,
      displayName: input.displayName ?? definition.name,
      credential: input.credential,
      enabled: input.enabled,
      capabilities,
    });
    this.runtime.refresh();
    return this.requireConfig(id);
  }

  update(id: string, input: UpdateProviderConfiguration): ConfiguredProvider {
    const existing = this.requireConfig(id);
    const definition = this.requireDefinition(existing.definitionId);
    let capabilities = existing.capabilities;

    if (input.capability) {
      const incoming = validateCapabilityConfigurations(definition, [input.capability])[0]!;
      if (incoming.enabled === false) {
        this.assertCapabilityNotInUse(id, incoming.capability);
      }
      capabilities = [
        ...existing.capabilities.filter(
          (capability) => capability.capability !== incoming.capability,
        ),
        incoming,
      ];
    }

    this.store.save({
      id,
      definitionId: existing.definitionId,
      displayName: input.displayName ?? existing.displayName,
      credential: resolveCredentialWrite(input.credential),
      enabled: input.enabled ?? existing.enabled,
      capabilities,
    });
    this.runtime.refresh();
    return this.requireConfig(id);
  }

  delete(id: string): void {
    this.requireConfig(id);
    const conflicts = this.bindings.listByProviderConfig(id);
    if (conflicts.length > 0) {
      throw new ProviderConfigurationError(
        'provider_in_use',
        '请先将使用该 Provider 的业务模块换绑或解绑',
        conflicts.map(toConflict),
      );
    }
    this.store.delete(id);
    this.runtime.refresh();
  }

  private requireConfig(id: string): ConfiguredProvider {
    const config = this.store.get(id);
    if (!config) throw new ProviderConfigurationError('not_found', 'Provider 不存在');
    return config;
  }

  private requireDefinition(id: string): ProviderDefinition {
    const definition = this.definitions.get(id);
    if (!definition) {
      throw new ProviderConfigurationError(
        'unknown_definition',
        `未知 Provider 定义：${id}`,
        [],
        id,
      );
    }
    return definition;
  }

  private assertCapabilityNotInUse(id: string, capability: Capability): void {
    const conflicts = this.bindings
      .listByProviderConfig(id)
      .filter((binding) => MODEL_BINDING_CAPABILITIES[binding.module] === capability);
    if (conflicts.length === 0) return;
    throw new ProviderConfigurationError(
      'provider_capability_in_use',
      '请先将使用该能力的业务模块换绑或解绑',
      conflicts.map((binding) => ({
        ...toConflict(binding),
        capability,
      })),
    );
  }
}

export function validateCapabilityConfigurations(
  definition: ProviderDefinition,
  requested: readonly ProviderCapabilityConfiguration[],
): ProviderCapabilityConfiguration[] {
  if (requested.length === 0) {
    throw new ProviderConfigurationError(
      'invalid_capability_config',
      '至少需要启用一项 Provider 能力',
    );
  }

  const seen = new Set<Capability>();
  return requested.map((configuration) => {
    if (seen.has(configuration.capability)) {
      throw new ProviderConfigurationError(
        'invalid_capability_config',
        `能力 ${configuration.capability} 重复`,
      );
    }
    seen.add(configuration.capability);

    if (!providerSupportsCapability(definition, configuration.capability)) {
      throw new ProviderConfigurationError(
        'invalid_capability_config',
        `${definition.name} 不支持 ${configuration.capability}`,
      );
    }
    if (configuration.protocol) {
      const choices = protocolsForCapability(definition, configuration.capability);
      if (!choices.includes(configuration.protocol)) {
        throw new ProviderConfigurationError(
          'invalid_capability_config',
          `${configuration.capability} 不支持协议 ${configuration.protocol}`,
        );
      }
    }
    if (configuration.embeddingRevision && configuration.capability !== 'embed') {
      throw new ProviderConfigurationError(
        'invalid_capability_config',
        'embeddingRevision 仅适用于 Embed 能力',
      );
    }
    return { ...configuration };
  });
}

function resolveCredentialWrite(
  operation: ProviderCredentialOperation | undefined,
): string | null | undefined {
  if (!operation || operation.type === 'keep') return undefined;
  if (operation.type === 'clear') return null;
  return operation.value;
}

function toConflict(binding: ResolvedModelBinding) {
  return {
    module: binding.module,
    model: binding.model,
  };
}
