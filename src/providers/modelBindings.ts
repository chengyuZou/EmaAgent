// 定义业务模块到 Provider 模型的稳定绑定身份，并统一处理绑定变化后的运行时同步。
import type { Capability } from './types.js';

export const MODEL_BINDING_MODULES = [
  'emotion',
  'memory',
  'router',
  'plan-parse',
  'title',
  'lightrag-embed',
  'lightrag-llm',
  'tts',
  'stt',
  'vision',
  'imagegen',
] as const;

export type ModelBindingModule = typeof MODEL_BINDING_MODULES[number];

export const MODEL_BINDING_CAPABILITIES: Partial<
  Readonly<Record<ModelBindingModule, Capability>>
> = Object.freeze({
  emotion: 'llm',
  memory: 'llm',
  router: 'llm',
  'plan-parse': 'llm',
  title: 'llm',
  'lightrag-llm': 'llm',
  'lightrag-embed': 'embed',
  tts: 'tts',
  stt: 'stt',
  vision: 'vision',
});

const BRIDGE_BINDING_MODULES = new Set<ModelBindingModule>([
  'lightrag-embed',
  'lightrag-llm',
]);

export interface ModelBindingInput {
  module: ModelBindingModule;
  providerConfigId: string;
  model: string;
  /** 仅 LightRAG Embed 绑定使用；其他模块保持为空。 */
  embeddingDimension?: number;
}

export interface ResolvedModelBinding {
  module: ModelBindingModule;
  providerConfigId: string;
  model: string;
  embeddingDimension: number | null;
}

export interface ModelBindingStore {
  list(): ResolvedModelBinding[];
  listByModule(module: ModelBindingModule): ResolvedModelBinding[];
  listByProviderConfig(providerConfigId: string): ResolvedModelBinding[];
  setSingle(input: ModelBindingInput): void;
  upsert(input: ModelBindingInput): void;
  delete(module: ModelBindingModule, providerConfigId: string, model: string): void;
  deleteByProviderModel(providerConfigId: string, model: string): number;
}

export interface ModelBindingRuntime {
  syncBridge(): Promise<void>;
}

export class ModelBindingControl {
  constructor(
    private readonly store: ModelBindingStore,
    private readonly runtime: ModelBindingRuntime,
  ) {}

  list(): ResolvedModelBinding[] {
    return this.store.list();
  }

  listByModule(module: ModelBindingModule): ResolvedModelBinding[] {
    return this.store.listByModule(module);
  }

  listByProviderConfig(providerConfigId: string): ResolvedModelBinding[] {
    return this.store.listByProviderConfig(providerConfigId);
  }

  setSingle(input: ModelBindingInput): ResolvedModelBinding[] {
    this.store.setSingle(input);
    this.syncBridgeIfNeeded(input.module);
    return this.store.listByModule(input.module);
  }

  upsert(input: ModelBindingInput): ResolvedModelBinding[] {
    this.store.upsert(input);
    this.syncBridgeIfNeeded(input.module);
    return this.store.listByModule(input.module);
  }

  delete(module: ModelBindingModule, providerConfigId: string, model: string): void {
    this.store.delete(module, providerConfigId, model);
    this.syncBridgeIfNeeded(module);
  }

  deleteByProviderModel(providerConfigId: string, model: string): number {
    return this.store.deleteByProviderModel(providerConfigId, model);
  }

  private syncBridgeIfNeeded(module: ModelBindingModule): void {
    if (!BRIDGE_BINDING_MODULES.has(module)) return;
    void this.runtime.syncBridge().catch((error: unknown) => {
      console.warn('[model-bindings] bridge sync failed:', error);
    });
  }
}
