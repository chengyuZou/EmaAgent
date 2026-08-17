// 保存用户已经启用的模型事实；Catalog 只负责创建或编辑时预填这些字段。
import type { ModelCapability } from './types.js';
import type { ProviderStore } from './providers.js';
import { ProviderError } from './errors.js';

interface ProviderModelIdentity<TCapability extends ModelCapability> {
  providerId: string;
  capability: TCapability;
  modelId: string;
  /** 用户可改的显示名；undefined = 前端回退显示 modelId。 */
  name?: string;
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

/** Vision 模型是支持视觉输入的 LLM：与 LLM 同参数集，capability 判别供绑定与探活分流。 */
export interface VisionProviderModel extends ProviderModelIdentity<'vision'> {
  contextWindow: number;
  maxOutput: number | null;
  toolCall: boolean | null;
  reasoning: boolean | null;
  temperature: boolean | null;
  inputImage: boolean | null;
}

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
  get(providerId: string, capability: ModelCapability, modelId: string): ProviderModel | undefined;
  listByProvider(providerId: string, capability?: ModelCapability): ProviderModel[];
  listByCapability(capability: ModelCapability): ProviderModel[];
  save(model: ProviderModel): void;
  delete(providerId: string, capability: ModelCapability, modelId: string): void;
}

export class ProviderModels {
  constructor(
    private readonly providers: Pick<ProviderStore, 'get'>,
    private readonly store: ProviderModelStore,
  ) {}

  listByProvider(providerId: string, capability?: ModelCapability): ProviderModel[] {
    this.requireProvider(providerId);
    return this.store.listByProvider(providerId, capability);
  }

  listByCapability(capability: ModelCapability): ProviderModel[] {
    return this.store.listByCapability(capability);
  }

  get(providerId: string, capability: ModelCapability, modelId: string): ProviderModel {
    const found = this.store.get(providerId, capability, modelId);
    if (!found) throw new ProviderError('model_not_found', 'Provider 模型不存在');
    return found;
  }

  /** 新增与修改同一路径：同主键再保存即更新（含 name 与全部参数）。 */
  save(model: ProviderModel): ProviderModel {
    const provider = this.requireProvider(model.providerId);
    const configured = provider.capabilities.find(
      (entry) => entry.capability === model.capability && entry.activeProtocol !== undefined,
    );
    if (!configured) {
      throw new ProviderError(
        'capability_disabled',
        `Provider 未启用 ${model.capability} 能力`,
      );
    }
    validateModel(model);
    this.store.save(model);
    return this.get(model.providerId, model.capability, model.modelId);
  }

  delete(providerId: string, capability: ModelCapability, modelId: string): void {
    this.get(providerId, capability, modelId);
    this.store.delete(providerId, capability, modelId);
  }

  private requireProvider(providerId: string) {
    const provider = this.providers.get(providerId);
    if (!provider) throw new ProviderError('not_found', 'Provider 不存在');
    return provider;
  }
}

function validateModel(model: ProviderModel): void {
  if (model.modelId.trim().length === 0) {
    throw new ProviderError('invalid_configuration', '模型 id 不能为空');
  }
  if (model.capability === 'llm' || model.capability === 'vision') {
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
    throw new ProviderError('invalid_configuration', `${field} 必须是正整数`);
  }
}
