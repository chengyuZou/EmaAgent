// 管理用户 Provider 连接，并把能力配置解析为六个 API 包可直接消费的连接。
import {
  defaultProtocolFor,
  isProtocolForCapability,
  listProviderCapabilities,
  presetBaseUrlFor,
  requiresCredentials,
} from './registry.js';
import { ProviderConfigError } from './errors.js';
import type { ModelBindingStore } from './modelBindings.js';
import type {
  ModelCapability,
  ModelCapabilityProtocol,
  Protocol,
  Provider,
  ProviderConnection,
  ProviderCredentialOperation,
} from './types.js';
import { PROVIDER_CONFIG_LIMITS } from './types.js';

export interface ProviderCapabilityConfig<
  TCapability extends ModelCapability = ModelCapability,
> {
  capability: TCapability;
  protocol: ModelCapabilityProtocol<TCapability>;
  baseUrl: string;
  enabled: boolean;
}

export interface ProviderConfig {
  id: string;
  /** null 表示用户自定义连接，不伪造内置 Provider 身份。 */
  providerId: string | null;
  displayName: string;
  hasCredential: boolean;
  enabled: boolean;
  capabilities: readonly ProviderCapabilityConfig[];
}

export interface ProviderHealth {
  status: 'ok' | 'failed' | 'unknown';
  lastProbedAt: number | null;
  latencyMs: number | null;
  lastError: string | null;
}

export interface ProviderWithHealth {
  config: ProviderConfig;
  health: ProviderHealth | null;
}

export interface SaveProviderConfig {
  id: string;
  providerId: string | null;
  displayName: string;
  /** undefined 保留，null 清空，string 替换。 */
  credential?: string | null;
  enabled: boolean;
  capabilities: readonly ProviderCapabilityConfig[];
}

export interface ProviderConfigStore {
  get(id: string): ProviderConfig | undefined;
  getWithHealth(id: string): ProviderWithHealth | undefined;
  listWithHealth(): ProviderWithHealth[];
  revealCredential(id: string): string | null;
  save(input: SaveProviderConfig): void;
  delete(id: string): void;
  recordHealth(providerConfigId: string, health: ProviderHealth): void;
}

export interface ProviderCatalog {
  get(id: string): Provider | undefined;
  list(): readonly Provider[];
}

export interface ProviderCapabilityConfigInput {
  capability: ModelCapability;
  protocol?: Protocol;
  baseUrl?: string;
  enabled?: boolean;
}

export interface CreateProviderConfig {
  providerId?: string | null;
  displayName?: string;
  credential?: string;
  enabled: boolean;
  capabilities?: readonly ProviderCapabilityConfigInput[];
}

export interface UpdateProviderConfig {
  displayName?: string;
  credential?: ProviderCredentialOperation;
  enabled?: boolean;
  capability?: ProviderCapabilityConfigInput;
}

export class ProviderConfigs {
  constructor(
    private readonly providers: ProviderCatalog,
    private readonly store: ProviderConfigStore,
    private readonly bindings: Pick<ModelBindingStore, 'listByProviderConfig'>,
    private readonly createId: () => string,
  ) {}

  listProviders(): readonly Provider[] {
    return this.providers.list();
  }

  listConfigs(): ProviderWithHealth[] {
    return this.store.listWithHealth();
  }

  getConfig(id: string): ProviderWithHealth {
    const provider = this.store.getWithHealth(id);
    if (!provider) throw notFound();
    return provider;
  }

  revealCredential(id: string): string {
    this.requireConfig(id);
    return this.store.revealCredential(id) ?? '';
  }

  create(input: CreateProviderConfig): ProviderConfig {
    const preset = input.providerId
      ? this.requireProvider(input.providerId)
      : undefined;
    const requested = input.capabilities
      ?? (preset
        ? listProviderCapabilities(preset).map((capability) => ({ capability }))
        : []);
    const capabilities = normalizeCapabilities(preset, requested);
    const displayName = normalizeDisplayName(input.displayName ?? preset?.name);

    const id = this.createId();
    this.store.save({
      id,
      providerId: preset?.id ?? null,
      displayName,
      credential: normalizeCredential(input.credential),
      enabled: input.enabled,
      capabilities,
    });
    return this.requireConfig(id);
  }

  update(id: string, input: UpdateProviderConfig): ProviderConfig {
    const existing = this.requireConfig(id);
    const preset = existing.providerId
      ? this.requireProvider(existing.providerId)
      : undefined;
    let capabilities = [...existing.capabilities];

    if (input.capability) {
      const incoming = normalizeCapabilities(preset, [input.capability])[0]!;
      if (!incoming.enabled) this.assertCapabilityNotInUse(id, incoming.capability);
      capabilities = [
        ...capabilities.filter((entry) => entry.capability !== incoming.capability),
        incoming,
      ];
    }

    this.store.save({
      id,
      providerId: existing.providerId,
      displayName: input.displayName === undefined
        ? existing.displayName
        : normalizeDisplayName(input.displayName),
      credential: resolveCredentialWrite(input.credential),
      enabled: input.enabled ?? existing.enabled,
      capabilities,
    });
    return this.requireConfig(id);
  }

  delete(id: string): void {
    this.requireConfig(id);
    const conflicts = this.bindings.listByProviderConfig(id);
    if (conflicts.length > 0) {
      throw new ProviderConfigError(
        'provider_in_use',
        '请先将使用该 Provider 的业务模块换绑或解绑',
        conflicts,
      );
    }
    this.store.delete(id);
  }

  resolveConnection<TCapability extends ModelCapability>(
    providerConfigId: string,
    capability: TCapability,
  ): ProviderConnection<TCapability> {
    const provider = this.requireConfig(providerConfigId);
    if (!provider.enabled) {
      throw new ProviderConfigError('capability_disabled', 'Provider 已停用');
    }
    const configured = provider.capabilities.find(
      (entry): entry is ProviderCapabilityConfig<TCapability> =>
        entry.capability === capability,
    );
    if (!configured?.enabled) {
      throw new ProviderConfigError(
        'capability_disabled',
        `Provider 未启用 ${capability} 能力`,
      );
    }

    const credential = this.store.revealCredential(providerConfigId);
    const preset = provider.providerId
      ? this.requireProvider(provider.providerId)
      : undefined;
    if (preset && requiresCredentials(preset) && !credential) {
      throw new ProviderConfigError('credential_missing', 'Provider 缺少 API Key');
    }

    return {
      protocol: configured.protocol,
      baseUrl: configured.baseUrl,
      ...(credential ? { apiKey: credential } : {}),
    };
  }

  recordHealth(id: string, health: ProviderHealth): void {
    this.requireConfig(id);
    this.store.recordHealth(id, health);
  }

  private requireConfig(id: string): ProviderConfig {
    const provider = this.store.get(id);
    if (!provider) throw notFound();
    return provider;
  }

  private requireProvider(id: string): Provider {
    const preset = this.providers.get(id);
    if (!preset) {
      throw new ProviderConfigError('unknown_provider', `未知 Provider 预设：${id}`);
    }
    return preset;
  }

  private assertCapabilityNotInUse(id: string, capability: ModelCapability): void {
    const conflicts = this.bindings
      .listByProviderConfig(id)
      .filter((binding) => binding.capability === capability);
    if (conflicts.length === 0) return;
    throw new ProviderConfigError(
      'provider_capability_in_use',
      `请先解绑正在使用 ${capability} 的业务模块`,
      conflicts,
    );
  }
}

export function normalizeCapabilities(
  preset: Provider | undefined,
  requested: readonly ProviderCapabilityConfigInput[],
): ProviderCapabilityConfig[] {
  if (requested.length === 0) {
    throw invalid('至少需要配置一项 Provider 能力');
  }

  const seen = new Set<ModelCapability>();
  return requested.map((entry) => {
    if (seen.has(entry.capability)) throw invalid(`能力 ${entry.capability} 重复`);
    seen.add(entry.capability);

    const protocol = entry.protocol
      ?? (preset ? defaultProtocolFor(preset, entry.capability) : undefined);
    if (!protocol || !isProtocolForCapability(entry.capability, protocol)) {
      throw invalid(`${entry.capability} 缺少有效协议`);
    }

    const baseUrl = entry.baseUrl
      ?? (preset ? presetBaseUrlFor(preset, entry.capability, protocol) : undefined);
    if (!baseUrl) {
      throw invalid(`${entry.capability} 使用非预设协议时必须填写 baseUrl`);
    }
    validateBaseUrl(baseUrl);

    return {
      capability: entry.capability,
      protocol,
      baseUrl,
      enabled: entry.enabled ?? true,
    } as ProviderCapabilityConfig;
  });
}

function normalizeDisplayName(value: string | undefined): string {
  const normalized = value?.trim() ?? '';
  if (normalized.length === 0 || normalized.length > PROVIDER_CONFIG_LIMITS.displayNameChars) {
    throw invalid('Provider 显示名称不能为空或过长');
  }
  return normalized;
}

function normalizeCredential(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  if (normalized.length > PROVIDER_CONFIG_LIMITS.apiKeyChars) {
    throw invalid('Provider API Key 过长');
  }
  return normalized;
}

function validateBaseUrl(value: string): void {
  if (value.length > PROVIDER_CONFIG_LIMITS.baseUrlChars) throw invalid('Provider baseUrl 过长');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(`无效的 Provider baseUrl：${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalid('Provider baseUrl 只允许 http 或 https');
  }
}

function resolveCredentialWrite(
  operation: ProviderCredentialOperation | undefined,
): string | null | undefined {
  if (!operation || operation.type === 'keep') return undefined;
  if (operation.type === 'clear') return null;
  return normalizeCredential(operation.value) ?? null;
}

function invalid(message: string): ProviderConfigError {
  return new ProviderConfigError('invalid_configuration', message);
}

function notFound(): ProviderConfigError {
  return new ProviderConfigError('not_found', 'Provider 不存在');
}
