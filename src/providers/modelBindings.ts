// 让每个业务模块只绑定一个已启用模型，不在 Provider 内触发业务副作用。
import { ProviderError } from './errors.js';
import { ModelBindingsRepo, type Database, type ModelBindingRow } from '@ema-agent/storage';
import type { ProviderModels } from './models.js';
import  { type ModelCapability, type ModelBindingModule, MODEL_BINDING_CAPABILITIES } from './types.js';

export const MODEL_BINDING_MODULES = [
  'memory-llm',
  'narrative-embed',
  'narrative-llm',
  'tts',
  'stt',
  'vision',
] as const;



export interface ModelBindingInput {
  module: ModelBindingModule;
  providerId: string;
  modelId: string;
}

export interface ModelBinding extends ModelBindingInput {
  capability: ModelCapability;
}

export class ModelBindings {
  private readonly repo: ModelBindingsRepo;

  constructor(db: Database, private readonly models: ProviderModels) {
    this.repo = new ModelBindingsRepo(db.sqlite);
  }

  get(module: ModelBindingModule): ModelBinding | undefined {
    const row = this.repo.get(module);
    return row ? this.toBinding(row) : undefined;
  }

  list(): ModelBinding[] {
    return this.repo.list().map((row) => this.toBinding(row));
  }

  listByProvider(providerId: string): ModelBinding[] {
    return this.repo.listByProvider(providerId).map((row) => this.toBinding(row));
  }

  set(input: ModelBindingInput): ModelBinding {
    const capability = MODEL_BINDING_CAPABILITIES[input.module];
    const model = this.models.get(input.providerId, capability, input.modelId);
    if (!model.enabled) {
      throw new ProviderError(
        'model_not_found',
        `${input.module} 只能绑定已启用的 ${capability} 模型`,
      );
    }
    const binding = { ...input, capability };
    this.repo.set({
      module: binding.module,
      capability: binding.capability,
      provider_id: binding.providerId,
      model_id: binding.modelId,
    });
    return binding;
  }

  delete(module: ModelBindingModule): void {
    this.repo.delete(module);
  }

  private toBinding(row: ModelBindingRow): ModelBinding {
    return {
      module: row.module,
      capability: row.capability,
      providerId: row.provider_id,
      modelId: row.model_id,
    };
  }
}
