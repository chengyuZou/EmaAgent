// 让每个业务模块只绑定一个已启用模型，不在 Provider 内触发业务副作用。
import { ProviderError } from './errors.js';
import type { ProviderModelStore } from './models.js';
import type { ModelCapability } from './types.js';

export const MODEL_BINDING_MODULES = [
  'memory-llm',
  'kb-embed',
  'kb-rerank',
  'title',
  'lightrag-embed',
  'lightrag-llm',
  'tts',
  'stt',
  'vision',
] as const;

export type ModelBindingModule = typeof MODEL_BINDING_MODULES[number];

export const MODEL_BINDING_CAPABILITIES: Readonly<Record<ModelBindingModule, ModelCapability>> =
  Object.freeze({
    'memory-llm': 'llm',
    'kb-embed': 'embed',
    'kb-rerank': 'rerank',
    title: 'llm',
    'lightrag-llm': 'llm',
    'lightrag-embed': 'embed',
    tts: 'tts',
    stt: 'stt',
    vision: 'vision',
  });

export interface ModelBindingInput {
  module: ModelBindingModule;
  providerId: string;
  modelId: string;
}

export interface ModelBinding extends ModelBindingInput {
  capability: ModelCapability;
}

export interface ModelBindingStore {
  get(module: ModelBindingModule): ModelBinding | undefined;
  list(): ModelBinding[];
  listByProvider(providerId: string): ModelBinding[];
  set(binding: ModelBinding): void;
  delete(module: ModelBindingModule): void;
}

export class ModelBindings {
  constructor(
    private readonly models: Pick<ProviderModelStore, 'get'>,
    private readonly store: ModelBindingStore,
  ) {}

  get(module: ModelBindingModule): ModelBinding | undefined {
    return this.store.get(module);
  }

  list(): ModelBinding[] {
    return this.store.list();
  }

  listByProvider(providerId: string): ModelBinding[] {
    return this.store.listByProvider(providerId);
  }

  set(input: ModelBindingInput): ModelBinding {
    const capability = MODEL_BINDING_CAPABILITIES[input.module];
    const model = this.models.get(input.providerId, capability, input.modelId);
    if (!model) {
      throw new ProviderError(
        'model_not_found',
        `${input.module} 只能绑定已启用的 ${capability} 模型`,
      );
    }
    const binding = { ...input, capability };
    this.store.set(binding);
    return binding;
  }

  delete(module: ModelBindingModule): void {
    this.store.delete(module);
  }
}
