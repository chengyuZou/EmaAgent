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
  /** 该能力的 models.dev 源 id；undefined = 不用 models.dev 预填模型参数。 */
  modelsDevId?: string;
  /** 该能力已配置的协议；同一能力可配多档（如 DeepSeek LLM 的 openai/anthropic 双协议）。 */
  protocols: readonly ProviderProtocol[];
  /** 读出时注入：该能力的模型行数（none 类型的"已配置"判定用它；写入输入不含）。 */
  modelCount?: number;
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
  /** 全文 key；掩码展示（取头尾拼接）是前端渲染规则，后端不参与。 */
  keyValue?: string;
  capabilities: readonly ProviderCapability[];
  health: readonly ProviderHealth[];
}

export interface ProviderCapabilityInput {
  capability: ModelCapability;
  /** 缺省时：该能力尚未配置协议则报错；已有协议则只改其余字段。 */
  protocol?: Protocol;
  baseUrl?: string;
  /** true = 设为该能力当前协议；false = 停用该能力（已配协议保留）；缺省 = 未启用时激活这条协议。 */
  active?: boolean;
  modelsDevId?: string;
  /** 本次要从该能力移除的协议档；剩最后一档时拒绝（不能把能力删成无协议）。 */
  removedProtocols?: readonly Protocol[];
}

export interface CreateProvider {
  /** 用户显式给定的语义 slug（如 deepseek / company-gateway）；创建后不可改，不能与已有行（含内置种子）重复。 */
  id: string;
  name: string;
  iconId?: string;
  authType: 'none' | 'bearer';
  /** 一把 key；bearer 未提供时先建行，配置动作补。 */
  key?: string;
  /** 创建动作按能力分区发起：一次创建只带一个能力。 */
  capability: ProviderCapabilityInput;
}

export interface UpdateProvider {
  name?: string;
  /** null = 清空图标。 */
  iconId?: string | null;
  /** null = 清空 key；undefined = 不动现有 key。 */
  key?: string | null;
  capability?: ProviderCapabilityInput;
}

export interface ProviderInput {
  id: string;
  name: string;
  iconId?: string;
  authType: 'none' | 'bearer';
  keyValue?: string;
  capabilities: readonly ProviderCapability[];
}

export interface ProviderStore {
  get(id: string): Provider | undefined;
  list(): Provider[];
  save(input: ProviderInput): void;
  delete(id: string): void;
  recordHealth(providerId: string, capability: ModelCapability, health: ProviderHealth): void;
}

export class Providers {
  constructor(
    private readonly store: ProviderStore,
    private readonly bindings: Pick<ModelBindingStore, 'listByProvider'>,
  ) {}

  list(): Provider[] {
    return this.store.list();
  }

  get(id: string): Provider {
    return this.requireProvider(id);
  }

  /** 只服务自建 provider；内置 19 个是种子行，配置动作走 update。按能力分区创建：单档协议即激活。
   *  判重按 (id, capability)：id 存在但无此能力 → 追加能力档（同 key 共享）；id+能力都有 → already_exists。 */
  create(input: CreateProvider): Provider {
    assertValidId(input.id);
    const existing = this.store.get(input.id);
    if (existing) {
      if (existing.capabilities.some((c) => c.capability === input.capability.capability)) {
        throw new ProviderError(
          'already_exists',
          `Provider ${input.id} 的 ${input.capability.capability} 能力已存在`,
        );
      }
      return this.update(input.id, {
        capability: input.capability,
        ...(input.key !== undefined ? { key: input.key } : {}),
      });
    }
    const protocol = normalizeCapabilityProtocol(input.capability);
    this.store.save({
      id: input.id,
      name: normalizeName(input.name),
      iconId: input.iconId,
      authType: input.authType,
      ...(input.key !== undefined ? { keyValue: normalizeKeyValue(input.key) } : {}),
      capabilities: [{
        capability: input.capability.capability,
        activeProtocol: protocol.protocol,
        protocols: [protocol],
      }],
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
      if (requested.removedProtocols !== undefined && requested.removedProtocols.length > 0) {
        for (const removed of requested.removedProtocols) {
          const index = protocols.findIndex((entry) => entry.protocol === removed);
          if (index >= 0) protocols.splice(index, 1);
        }
        if (protocols.length === 0) {
          throw invalid(`${requested.capability} 至少要保留一档协议`);
        }
        // 激活档被删时自动切到剩余第一档，不留悬空指针。
        if (activeProtocol !== undefined
          && !protocols.some((entry) => entry.protocol === activeProtocol)) {
          activeProtocol = protocols[0]!.protocol;
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
          modelsDevId: requested.modelsDevId ?? current?.modelsDevId,
          protocols,
        },
      ];
    }

    this.store.save({
      id,
      name: input.name === undefined ? existing.name : normalizeName(input.name),
      iconId: input.iconId === undefined ? existing.iconId : (input.iconId ?? undefined),
      authType: existing.authType,
      keyValue: input.key === undefined ? existing.keyValue
        : input.key === null ? undefined : normalizeKeyValue(input.key),
      capabilities,
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

  recordHealth(providerId: string, capability: ModelCapability, health: ProviderHealth): void {
    this.requireProvider(providerId);
    this.store.recordHealth(providerId, capability, health);
  }

  resolveConnection<TCapability extends ModelCapability>(
    providerId: string,
    capability: TCapability,
  ): ProviderConnection<TCapability> {
    const provider = this.requireProvider(providerId);
    return resolveProviderConnection(provider, provider.keyValue ?? null, capability);
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

export function normalizeCapabilityProtocol(entry: ProviderCapabilityInput): ProviderProtocol {
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
