import { ProviderError } from './errors.js';
import type { ModelsDevCatalog } from './catalog/modelsDevCatalog.js';
import type { ModelCapability } from './types.js';
import {
  ModelBindingsRepo,
  ProviderModelsRepo,
  type Database,
  type ProviderModelRow,
} from '@ema-agent/storage';
import type { Providers } from './providers.js';

export type ProviderModelSource = 'user' | 'dev';

interface ProviderModelIdentity<TCapability extends ModelCapability> {
  providerId: string;
  capability: TCapability;
  modelId: string;
  /** undefined 时界面显示 modelId. models.dev 同步会保存目录中的显示名. */
  name?: string;
}

export interface LLMProviderModel extends ProviderModelIdentity<'llm'> {
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

/** Vision 保留独立模型记录和绑定, 参数与 LLM 相同. */
export interface VisionProviderModel extends ProviderModelIdentity<'vision'> {
  contextWindow: number;
  maxOutput: number | null;
  toolCall: boolean | null;
  reasoning: boolean | null;
  temperature: boolean | null;
  inputImage: boolean | null;
}

export type TTSProviderModel = ProviderModelIdentity<'tts'>;
export type STTProviderModel = ProviderModelIdentity<'stt'>;

type ProviderModelParams =
  | LLMProviderModel
  | EmbedProviderModel
  | RerankProviderModel
  | VisionProviderModel
  | TTSProviderModel
  | STTProviderModel;

export type ProviderModelInput = ProviderModelParams;

export type ProviderModel = ProviderModelParams & { source: ProviderModelSource; enabled: boolean };

export class ProviderModels {
  private readonly repo: ProviderModelsRepo;
  private readonly bindingsRepo: ModelBindingsRepo;

  constructor(
    private readonly db: Database,
    private readonly providers: Providers,
    private readonly catalog: ModelsDevCatalog,
  ) {
    this.repo = new ProviderModelsRepo(db.sqlite);
    this.bindingsRepo = new ModelBindingsRepo(db.sqlite);
  }

  listByProvider(providerId: string, capability?: ModelCapability): ProviderModel[] {
    this.requireProvider(providerId);
    return this.repo.listByProvider(providerId, capability).map(fromRow);
  }

  listByCapability(capability: ModelCapability): ProviderModel[] {
    return this.repo.listByCapability(capability).map(fromRow);
  }

  /** 设置页据此判断是否需要显示首次配置提示, 已禁用的模型也计入. */
  hasAny(): boolean {
    return this.repo.hasAny();
  }

  get(providerId: string, capability: ModelCapability, modelId: string): ProviderModel {
    const found = this.repo.get(providerId, capability, modelId);
    if (!found) throw new ProviderError('model_not_found', 'Provider 模型不存在');
    return fromRow(found);
  }

  /** 手填模型首次保存时启用, 再次保存保留启用状态. 目录模型的参数由同步更新. */
  save(model: ProviderModelInput): ProviderModel {
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
    const existing = this.repo.get(model.providerId, model.capability, model.modelId);
    if (existing?.source === 'dev') {
      throw new ProviderError('invalid_configuration', '该模型来自 models.dev 目录，参数由目录维护');
    }
    this.repo.save(toRow({
      ...model,
      source: 'user',
      enabled: existing ? existing.enabled === 1 : true,
    }));
    return this.get(model.providerId, model.capability, model.modelId);
  }

  /** 停用已绑定的模型会返回 conflicts, 让设置页提示先解绑. */
  setEnabled(
    providerId: string,
    capability: ModelCapability,
    modelId: string,
    enabled: boolean,
  ): ProviderModel {
    const model = this.get(providerId, capability, modelId);
    if (!enabled) {
      this.assertModelNotInUse(providerId, capability, modelId);
    }
    if (model.enabled !== enabled) {
      this.repo.setEnabled(providerId, capability, modelId, enabled ? 1 : 0);
    }
    return this.get(providerId, capability, modelId);
  }

  delete(providerId: string, capability: ModelCapability, modelId: string): void {
    this.get(providerId, capability, modelId);
    this.assertModelNotInUse(providerId, capability, modelId);
    this.repo.delete(providerId, capability, modelId);
  }

  /**
   * 同一次事务同步指定供应商和能力, 返回该范围的模型记录.
   * 新模型默认禁用, 已有启用状态和手写参数保留, 目录中消失的模型不自动删除.
   */
  syncDevModels(providerId: string, capability: 'llm' | 'vision'): ProviderModel[] {
    const provider = this.requireProvider(providerId);
    const modelsDevId = provider.capabilities.find(entry => entry.capability === capability)?.modelsDevId;
    if (!modelsDevId) {
      throw new ProviderError('model_not_found', '该 Provider 未收录 models.dev 目录，模型只能手写');
    }
    return this.db.sqlite.transaction(() => {
      this.syncProviderModels(providerId, capability, modelsDevId);
      return this.repo.listByProvider(providerId, capability).map(fromRow);
    })();
  }

  private syncProviderModels(providerId: string, capability: 'llm' | 'vision', modelsDevId: string): void {
    const ids = capability === 'llm'
      ? this.catalog.listLLMModelIds(modelsDevId)
      : this.catalog.listVisionModelIds(modelsDevId);
    for (const id of ids) {
      const spec = this.catalog.get(modelsDevId, id);
      if (!spec?.contextWindow) continue;
      const existing = this.repo.get(providerId, capability, id);
      if (existing?.source === 'user') continue;
      this.repo.save(toRow({
        providerId,
        capability,
        modelId: spec.id,
        ...(spec.name !== undefined ? { name: spec.name } : {}),
        contextWindow: spec.contextWindow,
        maxOutput: spec.maxOutput ?? null,
        toolCall: spec.toolCall ?? null,
        reasoning: spec.reasoning ?? null,
        temperature: spec.temperature ?? null,
        inputImage: spec.inputImage ?? null,
        source: 'dev',
        enabled: existing ? existing.enabled === 1 : false,
      }));
    }
  }

  private assertModelNotInUse(providerId: string, capability: ModelCapability, modelId: string): void {
    const conflicts = this.bindingsRepo
      .listByProvider(providerId)
      .filter((binding) => binding.capability === capability && binding.model_id === modelId)
      .map((row) => ({
        module: row.module,
        capability: row.capability,
        providerId: row.provider_id,
        modelId: row.model_id,
      }));
    if (conflicts.length > 0) {
      throw new ProviderError('model_in_use', '请先解绑正在使用该模型的业务模块', conflicts);
    }
  }

  private requireProvider(providerId: string) {
    return this.providers.get(providerId);
  }
}

function validateModel(model: ProviderModelInput): void {
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

function fromRow(row: ProviderModelRow): ProviderModel {
  const identity = {
    providerId: row.provider_id,
    modelId: row.model_id,
    ...(row.name === null ? {} : { name: row.name }),
    source: row.source,
    enabled: row.enabled === 1,
  };
  switch (row.capability) {
    case 'llm':
    case 'vision':
      return {
        ...identity,
        capability: row.capability,
        contextWindow: row.context_window!,
        maxOutput: row.max_output,
        toolCall: fromBoolean(row.tool_call),
        reasoning: fromBoolean(row.reasoning),
        temperature: fromBoolean(row.temperature),
        inputImage: fromBoolean(row.input_image),
      };
    case 'embed':
      return { ...identity, capability: 'embed', dim: row.embedding_dim! };
    case 'rerank':
      return { ...identity, capability: 'rerank', maxChunks: row.rerank_max_chunks };
    case 'tts':
      return { ...identity, capability: 'tts' };
    case 'stt':
      return { ...identity, capability: 'stt' };
  }
}

function toRow(model: ProviderModel): ProviderModelRow {
  const withWindow = model.capability === 'llm' || model.capability === 'vision';
  return {
    provider_id: model.providerId,
    capability: model.capability,
    model_id: model.modelId,
    name: model.name ?? null,
    source: model.source,
    enabled: model.enabled ? 1 : 0,
    context_window: withWindow ? model.contextWindow : null,
    max_output: withWindow ? model.maxOutput : null,
    tool_call: withWindow ? toBoolean(model.toolCall) : null,
    reasoning: withWindow ? toBoolean(model.reasoning) : null,
    temperature: withWindow ? toBoolean(model.temperature) : null,
    input_image: withWindow ? toBoolean(model.inputImage) : null,
    embedding_dim: model.capability === 'embed' ? model.dim : null,
    rerank_max_chunks: model.capability === 'rerank' ? model.maxChunks : null,
  };
}

function toBoolean(value: boolean | null): number | null {
  if (value === null) return null;
  return value ? 1 : 0;
}

function fromBoolean(value: number | null): boolean | null {
  return value === null ? null : value === 1;
}
