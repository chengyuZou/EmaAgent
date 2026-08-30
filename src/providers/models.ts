// 模型池事实：种子建议（source='seed'，不可删除）与手动添加（'user'）同表；
// 有行即该 Provider 已知可用模型，可用性门槛是连接可解析（见 Route 的 /available 与绑定断言）。
// Catalog 只负责创建或编辑时预填参数字段。
import { ProviderError } from './errors.js';
import type { ModelCapability } from './types.js';
import type { ProviderStore } from './providers.js';

export type ProviderModelSource = 'seed' | 'user';

interface ProviderModelIdentity<TCapability extends ModelCapability> {
  providerId: string;
  capability: TCapability;
  modelId: string;
  /** 用户可改的显示名；undefined = 前端回退显示 modelId。 */
  name?: string;
}

// ── 保存输入（不含 source）─────────────────────────────────────────────────────
// 手动新增即 'user'；已有行再保存保留原 source（编辑种子参数不把它变成用户行）。

export interface LlmProviderModelInput extends ProviderModelIdentity<'llm'> {
  contextWindow: number;
  maxOutput: number | null;
  toolCall: boolean | null;
  reasoning: boolean | null;
  temperature: boolean | null;
  inputImage: boolean | null;
}

export interface EmbedProviderModelInput extends ProviderModelIdentity<'embed'> {
  dim: number;
}

export interface RerankProviderModelInput extends ProviderModelIdentity<'rerank'> {
  maxChunks: number | null;
}

/** Vision 模型是支持视觉输入的 LLM：与 LLM 同参数集，capability 判别供绑定与探活分流。 */
export interface VisionProviderModelInput extends ProviderModelIdentity<'vision'> {
  contextWindow: number;
  maxOutput: number | null;
  toolCall: boolean | null;
  reasoning: boolean | null;
  temperature: boolean | null;
  inputImage: boolean | null;
}

export type TtsProviderModelInput = ProviderModelIdentity<'tts'>;
export type SttProviderModelInput = ProviderModelIdentity<'stt'>;

export type ProviderModelInput =
  | LlmProviderModelInput
  | EmbedProviderModelInput
  | RerankProviderModelInput
  | VisionProviderModelInput
  | TtsProviderModelInput
  | SttProviderModelInput;

// ── 持久化事实：输入 + 来源 ─────────────────────────────────────────────────────

export interface LlmProviderModel extends LlmProviderModelInput { source: ProviderModelSource; }
export interface EmbedProviderModel extends EmbedProviderModelInput { source: ProviderModelSource; }
export interface RerankProviderModel extends RerankProviderModelInput { source: ProviderModelSource; }
export interface VisionProviderModel extends VisionProviderModelInput { source: ProviderModelSource; }
export interface TtsProviderModel extends TtsProviderModelInput { source: ProviderModelSource; }
export interface SttProviderModel extends SttProviderModelInput { source: ProviderModelSource; }

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

  /** 新增与修改同一路径：同主键再保存即更新（含 name 与全部参数）；新增行 source='user'，已有行保留来源。 */
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
    const existing = this.store.get(model.providerId, model.capability, model.modelId);
    this.store.save({ ...model, source: existing?.source ?? 'user' });
    return this.get(model.providerId, model.capability, model.modelId);
  }

  /** 种子建议是内置内容，删除会留下"下次重放迁移该不该复活"的烂摊子，一律拒绝；user 行随意删。 */
  delete(providerId: string, capability: ModelCapability, modelId: string): void {
    const model = this.get(providerId, capability, modelId);
    if (model.source === 'seed') {
      throw new ProviderError('invalid_configuration', '内置建议模型不能删除；不需要它就不绑定它');
    }
    this.store.delete(providerId, capability, modelId);
  }

  private requireProvider(providerId: string) {
    const provider = this.providers.get(providerId);
    if (!provider) throw new ProviderError('not_found', 'Provider 不存在');
    return provider;
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
