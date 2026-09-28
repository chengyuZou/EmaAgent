// 模型池事实：provider_models 行 = 启用集合的载体。手写行（source='user'）可编辑/启停/删除；
// dev 行（source='dev'）由 models.dev 同步落库，禁修改参数、可启停/删除，刷新时参数以目录为准（enabled 不动）。
// enabled=1 是绑定、/available 与探活的唯一准入；目录只是内部拉取来源，不直接进表也不公开。
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
  /** 显示名快照（目录同步时自带）；undefined = 前端回退显示 modelId。 */
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

type ProviderModelParams =
  | LlmProviderModel
  | EmbedProviderModel
  | RerankProviderModel
  | VisionProviderModel
  | TtsProviderModel
  | SttProviderModel;

export type ProviderModelInput = ProviderModelParams;

export type ProviderModel = ProviderModelParams & { source: ProviderModelSource; enabled: boolean };

export class ProviderModels {
  private readonly repo: ProviderModelsRepo;
  private readonly bindingsRepo: ModelBindingsRepo;

  constructor(
    db: Database,
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

  /** 首次使用判定：表里有没有任何模型行（目录同步落库或手写都算"用过"）。 */
  hasAny(): boolean {
    return this.repo.hasAny();
  }

  get(providerId: string, capability: ModelCapability, modelId: string): ProviderModel {
    const found = this.repo.get(providerId, capability, modelId);
    if (!found) throw new ProviderError('model_not_found', 'Provider 模型不存在');
    return fromRow(found);
  }

  /** 手写保存：新增行 source='user' 且默认启用；已有行保留 source 与 enabled。dev 行禁修改。 */
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

  /** 启停开关；停用正被业务模块绑定的模型拒绝（前端拿 conflicts 弹窗引导解绑）。 */
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
   * models.dev 同步：把该能力的目录模型写入 SQL——新 spec 默认禁用（enabled=0，source='dev'）；
   * 已有 dev 行参数以目录为准（enabled 不动）；同 id 手写行（source='user'）不动。目录下架的行保留。
   */
  syncDevModels(providerId: string, capability: 'llm' | 'vision'): ProviderModel[] {
    const provider = this.requireProvider(providerId);
    const modelsDevId = provider.capabilities.find(
      (entry) => entry.capability === capability,
    )?.modelsDevId;
    if (!modelsDevId) {
      throw new ProviderError('model_not_found', '该 Provider 未收录 models.dev 目录，模型只能手写');
    }
    const ids = capability === 'llm'
      ? this.catalog.listLlmModelIds(modelsDevId)
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
    return this.repo.listByProvider(providerId, capability).map(fromRow);
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
