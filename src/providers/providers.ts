// Provider 控制面：管理 providers 行与按能力隔离的 key，
// 并把能力配置解析为六个 API 包可直接消费的连接。
import { ProviderError } from './errors.js';
import type { ModelBindingStore } from './modelBindings.js';
import type {
  ModelCapability,
  ModelCapabilityProtocol,
  Protocol,
  ProviderConnection,
} from './types.js';
import { isProtocolForCapability, PROVIDER_LIMITS } from './types.js';

/** 能力下已配置的一档协议及其地址。 */
export interface ProviderProtocol {
  protocol: Protocol;
  baseUrl: string;
}

export interface ProviderCapability {
  capability: ModelCapability;
  /** 当前使用的协议；undefined = 该能力停用（已配协议保留）。 */
  activeProtocol?: Protocol;
  /** 当前使用哪把 key；undefined = 未配 key。 */
  activeKeyId?: string;
  /** 该能力的 models.dev 源 id；undefined = 不用 models.dev 预填模型参数。 */
  modelsDevId?: string;
  /** 该能力已配置的协议；同一能力可配多档（如 DeepSeek LLM 的 openai/anthropic 双协议）。 */
  protocols: readonly ProviderProtocol[];
}

export interface ProviderHealth {
  capability: ModelCapability;
  status: 'ok' | 'failed' | 'unknown';
  lastProbedAt: number | null;
  latencyMs: number | null;
  lastError: string | null;
}

/** providers 行的领域投影：配置、能力与按能力健康一次 join 拼好，读不拆壳。 */
export interface Provider {
  id: string;
  name: string;
  /** UI 图标注册表 key；undefined = 前端不渲染图标。 */
  iconId?: string;
  authType: 'none' | 'bearer';
  enabled: boolean;
  capabilities: readonly ProviderCapability[];
  health: readonly ProviderHealth[];
}

/** key 列表投影，keyValue 为全文；掩码展示（取头尾拼接）是前端渲染规则，后端不参与。 */
export interface ProviderKey {
  id: string;
  providerId: string;
  capability: ModelCapability;
  keyValue: string;
  createdAt: number;
}

export interface ProviderCapabilityInput {
  capability: ModelCapability;
  /** 缺省时：该能力尚未配置协议则报错；已有协议则只改其余字段。 */
  protocol?: Protocol;
  baseUrl?: string;
  /** true = 设为该能力当前协议；false = 停用该能力（已配协议保留）；缺省 = 未启用时激活这条协议。 */
  active?: boolean;
  modelsDevId?: string;
  /** 本次创建/激活该能力时一并写入的首把 key；写入后置为 active。 */
  key?: string;
}

export interface CreateProvider {
  /** 用户选定；创建后不可改，且不能与已有行（含内置种子）重复。 */
  id: string;
  name: string;
  iconId?: string;
  authType: 'none' | 'bearer';
  enabled: boolean;
  capabilities: readonly ProviderCapabilityInput[];
}

export interface UpdateProvider {
  name?: string;
  /** null = 清空图标。 */
  iconId?: string | null;
  enabled?: boolean;
  capability?: ProviderCapabilityInput;
}

/** 随保存一并写入的新 key；写入后对应能力的 active_key_id 指向它。 */
export interface ProviderNewKey {
  id: string;
  capability: ModelCapability;
  keyValue: string;
}

export interface ProviderInput {
  id: string;
  name: string;
  iconId?: string;
  authType: 'none' | 'bearer';
  enabled: boolean;
  capabilities: readonly ProviderCapability[];
  newKeys?: readonly ProviderNewKey[];
}

export interface ProviderStore {
  get(id: string): Provider | undefined;
  list(): Provider[];
  save(input: ProviderInput): void;
  delete(id: string): void;
  listKeys(providerId: string, capability: ModelCapability): ProviderKey[];
  /** 插入 key 并把该能力的 active_key_id 拨到它（同一事务）。 */
  addKey(entry: {
    id: string;
    providerId: string;
    capability: ModelCapability;
    keyValue: string;
    createdAt: number;
  }): void;
  setActiveKey(providerId: string, capability: ModelCapability, keyId: string): void;
  deleteKey(keyId: string): void;
  /** 全 provider 最近一把 key 的值；某能力首次配置时的预填补全来源。 */
  latestKeyValue(providerId: string): string | undefined;
  recordHealth(providerId: string, capability: ModelCapability, health: ProviderHealth): void;
}

export class Providers {
  constructor(
    private readonly store: ProviderStore,
    private readonly bindings: Pick<ModelBindingStore, 'listByProvider'>,
    private readonly createId: () => string,
  ) {}

  list(): Provider[] {
    return this.store.list();
  }

  get(id: string): Provider {
    return this.requireProvider(id);
  }

  /** 只服务自建 provider；内置 19 个是种子行，配置动作走 update。 */
  create(input: CreateProvider): Provider {
    assertValidId(input.id);
    if (this.store.get(input.id)) {
      throw new ProviderError('already_exists', `Provider id 已存在：${input.id}`);
    }
    const capabilities = normalizeCapabilities(input.capabilities);
    const newKeys = collectNewKeys(input.capabilities, capabilities, this.createId);

    this.store.save({
      id: input.id,
      name: normalizeName(input.name),
      iconId: input.iconId,
      authType: input.authType,
      enabled: input.enabled,
      capabilities,
      newKeys,
    });
    return this.requireProvider(input.id);
  }

  update(id: string, input: UpdateProvider): Provider {
    const existing = this.requireProvider(id);
    let capabilities = [...existing.capabilities];

    if (input.capability) {
      const requested = input.capability;
      const current = existing.capabilities.find(
        (entry) => entry.capability === requested.capability,
      );
      const protocols = [...(current?.protocols ?? [])];
      let activeProtocol = current?.activeProtocol;
      if (requested.protocol !== undefined) {
        const incoming = normalizeCapabilityProtocol(requested);
        const index = protocols.findIndex((entry) => entry.protocol === incoming.protocol);
        if (index >= 0) protocols.splice(index, 1);
        protocols.push(incoming);
        if (requested.active === true || activeProtocol === undefined) {
          activeProtocol = incoming.protocol;
        }
      }
      if (requested.active === false) {
        this.assertCapabilityNotInUse(id, requested.capability);
        activeProtocol = undefined;
      }
      capabilities = [
        ...capabilities.filter((entry) => entry.capability !== requested.capability),
        {
          capability: requested.capability,
          ...(activeProtocol !== undefined ? { activeProtocol } : {}),
          ...(current?.activeKeyId !== undefined ? { activeKeyId: current.activeKeyId } : {}),
          modelsDevId: requested.modelsDevId ?? current?.modelsDevId,
          protocols,
        },
      ];
    }

    const newKeys = input.capability?.key !== undefined
      ? [{ id: this.createId(), capability: input.capability.capability, keyValue: normalizeKeyValue(input.capability.key) }]
      : [];
    if (newKeys.length > 0) {
      const target = capabilities.find((entry) => entry.capability === input.capability!.capability)!;
      target.activeKeyId = newKeys[0]!.id;
    }

    this.store.save({
      id,
      name: input.name === undefined ? existing.name : normalizeName(input.name),
      iconId: input.iconId === undefined ? existing.iconId : (input.iconId ?? undefined),
      authType: existing.authType,
      enabled: input.enabled ?? existing.enabled,
      capabilities,
      newKeys,
    });
    return this.requireProvider(id);
  }

  delete(id: string): void {
    this.requireProvider(id);
    const conflicts = this.bindings.listByProvider(id);
    if (conflicts.length > 0) {
      throw new ProviderError(
        'provider_in_use',
        '请先将使用该 Provider 的业务模块换绑或解绑',
        conflicts,
      );
    }
    this.store.delete(id);
  }

  listKeys(providerId: string, capability: ModelCapability): ProviderKey[] {
    this.requireProvider(providerId);
    return this.store.listKeys(providerId, capability);
  }

  addKey(providerId: string, capability: ModelCapability, keyValue: string): ProviderKey {
    const provider = this.requireProvider(providerId);
    if (!provider.capabilities.some((entry) => entry.capability === capability)) {
      throw invalid(`Provider 未配置 ${capability} 能力，无法写入 key`);
    }
    const id = this.createId();
    this.store.addKey({
      id,
      providerId,
      capability,
      keyValue: normalizeKeyValue(keyValue),
      createdAt: Date.now(),
    });
    return this.store.listKeys(providerId, capability).find((key) => key.id === id)!;
  }

  selectKey(providerId: string, capability: ModelCapability, keyId: string): void {
    this.requireProvider(providerId);
    if (!this.store.listKeys(providerId, capability).some((key) => key.id === keyId)) {
      throw notFound('Provider key 不存在');
    }
    this.store.setActiveKey(providerId, capability, keyId);
  }

  deleteKey(providerId: string, capability: ModelCapability, keyId: string): void {
    const provider = this.requireProvider(providerId);
    const current = provider.capabilities.find((entry) => entry.capability === capability);
    if (current?.activeKeyId === keyId) {
      throw invalid('该 key 正在使用，请先切换到其他 key');
    }
    this.store.deleteKey(keyId);
  }

  /** 某能力首次配置时的 key 预填：全 provider 最近一把 key 的值；已有 key 则不预填。 */
  prefillKey(providerId: string, capability: ModelCapability): string | undefined {
    this.requireProvider(providerId);
    if (this.store.listKeys(providerId, capability).length > 0) return undefined;
    return this.store.latestKeyValue(providerId);
  }

  recordHealth(providerId: string, capability: ModelCapability, health: ProviderHealth): void {
    this.requireProvider(providerId);
    this.store.recordHealth(providerId, capability, health);
  }

  resolveConnection<TCapability extends ModelCapability>(
    providerId: string,
    capability: TCapability,
  ): ProviderConnection<TCapability> {
    const provider = this.requireProvider(providerId);
    const configured = provider.capabilities.find(
      (entry) => entry.capability === capability,
    );
    const keyValue = configured?.activeKeyId !== undefined
      ? (this.store.listKeys(providerId, capability)
          .find((key) => key.id === configured.activeKeyId)?.keyValue ?? null)
      : null;
    return resolveProviderConnection(provider, keyValue, capability);
  }

  private requireProvider(id: string): Provider {
    const provider = this.store.get(id);
    if (!provider) throw notFound('Provider 不存在');
    return provider;
  }

  private assertCapabilityNotInUse(id: string, capability: ModelCapability): void {
    const conflicts = this.bindings
      .listByProvider(id)
      .filter((binding) => binding.capability === capability);
    if (conflicts.length === 0) return;
    throw new ProviderError(
      'provider_capability_in_use',
      `请先解绑正在使用 ${capability} 的业务模块`,
      conflicts,
    );
  }
}

/** 解析是 Provider 自己的事：输入全部是 provider 行的事实 + 凭据，无任何外部状态。 */
export function resolveProviderConnection<TCapability extends ModelCapability>(
  provider: Provider,
  keyValue: string | null,
  capability: TCapability,
): ProviderConnection<TCapability> {
  if (!provider.enabled) {
    throw new ProviderError('capability_disabled', 'Provider 已停用');
  }
  const configured = provider.capabilities.find(
    (entry) => entry.capability === capability,
  );
  const active = configured?.protocols.find(
    (entry) => entry.protocol === configured.activeProtocol,
  );
  if (!configured || !active) {
    throw new ProviderError(
      'capability_disabled',
      `Provider 未启用 ${capability} 能力`,
    );
  }
  if (provider.authType === 'bearer' && !keyValue) {
    throw new ProviderError('credential_missing', 'Provider 缺少 API Key');
  }

  return {
    providerId: provider.id,
    protocol: active.protocol as ModelCapabilityProtocol<TCapability>,
    baseUrl: active.baseUrl,
    ...(keyValue ? { apiKey: keyValue } : {}),
  };
}

export function normalizeCapabilities(
  requested: readonly ProviderCapabilityInput[],
): ProviderCapability[] {
  if (requested.length === 0) {
    throw invalid('至少需要配置一项 Provider 能力');
  }

  const byCapability = new Map<ModelCapability, ProviderCapabilityInput[]>();
  for (const entry of requested) {
    const entries = byCapability.get(entry.capability) ?? [];
    if (entry.protocol !== undefined
      && entries.some((item) => item.protocol === entry.protocol)) {
      throw invalid(`能力 ${entry.capability} 的协议 ${entry.protocol} 重复`);
    }
    entries.push(entry);
    byCapability.set(entry.capability, entries);
  }

  return [...byCapability.entries()].map(([capability, entries]) => {
    const protocols = entries.map((entry) => normalizeCapabilityProtocol(entry));
    const activeIndex = entries.findIndex((entry) => entry.active === true);
    const active = protocols[activeIndex >= 0 ? activeIndex : 0]!;
    return {
      capability,
      activeProtocol: active.protocol,
      modelsDevId: entries[0]?.modelsDevId,
      protocols,
    };
  });
}

function collectNewKeys(
  requested: readonly ProviderCapabilityInput[],
  capabilities: readonly ProviderCapability[],
  createId: () => string,
): ProviderNewKey[] {
  const newKeys: ProviderNewKey[] = [];
  for (const entry of requested) {
    if (entry.key === undefined) continue;
    const newKey = {
      id: createId(),
      capability: entry.capability,
      keyValue: normalizeKeyValue(entry.key),
    };
    newKeys.push(newKey);
    capabilities.find((item) => item.capability === entry.capability)!.activeKeyId = newKey.id;
  }
  return newKeys;
}

function normalizeCapabilityProtocol(entry: ProviderCapabilityInput): ProviderProtocol {
  if (entry.protocol === undefined || !isProtocolForCapability(entry.capability, entry.protocol)) {
    throw invalid(`${entry.capability} 缺少有效协议`);
  }
  if (entry.baseUrl === undefined) {
    throw invalid(`${entry.capability} 必须填写 baseUrl`);
  }
  validateBaseUrl(entry.baseUrl);
  return { protocol: entry.protocol, baseUrl: entry.baseUrl };
}

function assertValidId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(id) || id.length > PROVIDER_LIMITS.idChars) {
    throw invalid('Provider id 只能包含字母、数字、中划线、下划线，且不超过 64 字符');
  }
}

function normalizeName(value: string | undefined): string {
  const normalized = value?.trim() ?? '';
  if (normalized.length === 0 || normalized.length > PROVIDER_LIMITS.nameChars) {
    throw invalid('Provider 显示名称不能为空或过长');
  }
  return normalized;
}

function normalizeKeyValue(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw invalid('Provider API Key 不能为空');
  if (normalized.length > PROVIDER_LIMITS.apiKeyChars) {
    throw invalid('Provider API Key 过长');
  }
  return normalized;
}

function validateBaseUrl(value: string): void {
  if (value.length > PROVIDER_LIMITS.baseUrlChars) throw invalid('Provider baseUrl 过长');
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

function invalid(message: string): ProviderError {
  return new ProviderError('invalid_configuration', message);
}

function notFound(message = 'Provider 不存在'): ProviderError {
  return new ProviderError('not_found', message);
}
