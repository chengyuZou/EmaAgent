// 保存用户已经启用的模型事实；Catalog 只负责创建或编辑时预填这些字段。
import type { ModelCapability } from './types.js';
import type { ProviderConfigStore } from './configuration.js';
import { ProviderConfigError } from './errors.js';

interface ProviderModelIdentity<TCapability extends ModelCapability> {
  providerConfigId: string;
  capability: TCapability;
  model: string;
}

export interface LlmProviderModel extends ProviderModelIdentity<'llm'> {
  contextWindow: number;
  maxOutput: number | null;
  toolCall: boolean | null;
  reasoning: boolean | null;
  temperature: boolean | null;
  inputImage: boolean | null;
}

export interface EmbedProviderModel extends ProviderModelIdentity<'embed'> {
  dim: number;
}

export interface RerankProviderModel extends ProviderModelIdentity<'rerank'> {
  maxChunks: number | null;
}

export type VisionProviderModel = ProviderModelIdentity<'vision'>;
export type TtsProviderModel = ProviderModelIdentity<'tts'>;
export type SttProviderModel = ProviderModelIdentity<'stt'>;

export type ProviderModel =
  | LlmProviderModel
  | EmbedProviderModel
  | RerankProviderModel
  | VisionProviderModel
  | TtsProviderModel
  | SttProviderModel;

export interface ProviderModelStore {
  get(providerConfigId: string, capability: ModelCapability, model: string): ProviderModel | undefined;
  listByProvider(providerConfigId: string, capability?: ModelCapability): ProviderModel[];
  listByCapability(capability: ModelCapability): ProviderModel[];
  save(model: ProviderModel): void;
  delete(providerConfigId: string, capability: ModelCapability, model: string): void;
}

export class ProviderModels {
  constructor(
    private readonly configurations: Pick<ProviderConfigStore, 'get'>,
    private readonly store: ProviderModelStore,
  ) {}

  listByProvider(providerConfigId: string, capability?: ModelCapability): ProviderModel[] {
    this.requireProvider(providerConfigId);
    return this.store.listByProvider(providerConfigId, capability);
  }

  listByCapability(capability: ModelCapability): ProviderModel[] {
    return this.store.listByCapability(capability);
  }

  get(providerConfigId: string, capability: ModelCapability, model: string): ProviderModel {
    const found = this.store.get(providerConfigId, capability, model);
    if (!found) throw new ProviderConfigError('model_not_found', 'Provider 模型不存在');
    return found;
  }

  save(model: ProviderModel): ProviderModel {
    const provider = this.requireProvider(model.providerConfigId);
    const configured = provider.capabilities.find(
      (entry) => entry.capability === model.capability && entry.activeProtocol !== undefined,
    );
    if (!configured) {
      throw new ProviderConfigError(
        'capability_disabled',
        `Provider 未启用 ${model.capability} 能力`,
      );
    }
    validateModel(model);
    this.store.save(model);
    return this.get(model.providerConfigId, model.capability, model.model);
  }

  delete(providerConfigId: string, capability: ModelCapability, model: string): void {
    this.get(providerConfigId, capability, model);
    this.store.delete(providerConfigId, capability, model);
  }

  private requireProvider(providerConfigId: string) {
    const provider = this.configurations.get(providerConfigId);
    if (!provider) throw new ProviderConfigError('not_found', 'Provider 不存在');
    return provider;
  }
}

function validateModel(model: ProviderModel): void {
  if (model.model.trim().length === 0) {
    throw new ProviderConfigError('invalid_configuration', '模型名称不能为空');
  }
  if (model.capability === 'llm') {
    positive(model.contextWindow, 'contextWindow');
    if (model.maxOutput !== null) positive(model.maxOutput, 'maxOutput');
  } else if (model.capability === 'embed') {
    positive(model.dim, 'dim');
  } else if (model.capability === 'rerank' && model.maxChunks !== null) {
    positive(model.maxChunks, 'maxChunks');
  }
}

function positive(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ProviderConfigError('invalid_configuration', `${field} 必须是正整数`);
  }
}
