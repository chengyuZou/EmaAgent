// 缓存已启用的 LLM 模型目录，供模型选择器和上下文球共享同一份能力数据。
import { create } from 'zustand';
import { providersApi, type AvailableModel } from '../api/providers.js';

export type ModelCatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ModelCatalogStoreState {
  models: AvailableModel[];
  status: ModelCatalogStatus;
  error: string | null;
  load(force?: boolean): Promise<void>;
}

let loadPromise: Promise<void> | null = null;

export const useModelCatalogStore = create<ModelCatalogStoreState>((set, get) => ({
  models: [],
  status: 'idle',
  error: null,

  async load(force = false) {
    if (!force && get().status === 'ready') return;
    if (loadPromise) return loadPromise;

    set({ status: 'loading', error: null });
    loadPromise = providersApi.listAvailable('llm')
      .then(({ models }) => {
        set({ models: [...models], status: 'ready', error: null });
      })
      .catch((error: unknown) => {
        set({
          status: 'error',
          error: error instanceof Error ? error.message : '加载模型目录失败',
        });
      })
      .finally(() => {
        loadPromise = null;
      });
    return loadPromise;
  },
}));

export function findEnabledModel(
  models: AvailableModel[],
  providerId: string | null | undefined,
  modelId: string | null | undefined,
): AvailableModel | undefined {
  if (!providerId || !modelId) return undefined;
  return models.find(
    (model) => model.providerId === providerId && model.modelId === modelId,
  );
}
