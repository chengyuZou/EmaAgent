// Provider 事实族单一入口：Provider 配置、业务位模型绑定与已启用 LLM 模型目录。
// 三者同源（providersApi），聊天模型选择器与设置页共享同一份数据。
import { create } from 'zustand';
import {
  providersApi,
  type AvailableModel,
  type ProviderRecord,
  type ProviderConfigInput,
  type ProviderPatchInput,
  type BindingModule,
  type BindingUpsertInput,
  type BindingsList,
} from '../api/providers.js';

export type ModelCatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ProviderStoreState {
  providers:           ProviderRecord[];
  /** 一个业务位一条绑定；缺省模块表示跟随系统默认解析。 */
  bindings:            Partial<Record<BindingModule, BindingsList[number]>>;
  /** 已启用的 LLM 可用模型目录；状态机独立，不阻塞 Provider/绑定装载。 */
  models:              AvailableModel[];
  modelsStatus:        ModelCatalogStatus;
  loading:             boolean;
  error:               string | null;

  loadAll():                                          Promise<void>;
  refreshProviders():                                 Promise<void>;
  refreshBindings():                                  Promise<void>;
  loadModels(force?: boolean):                        Promise<void>;

  createProvider(input: ProviderConfigInput):         Promise<void>;
  patchProvider(id: string, patch: ProviderPatchInput): Promise<void>;
  deleteProvider(id: string):                         Promise<void>;

  upsertBinding(module: BindingModule, input: BindingUpsertInput): Promise<void>;
  deleteBinding(module: BindingModule):               Promise<void>;
}

let modelsLoadPromise: Promise<void> | null = null;

export const useProviderStore = create<ProviderStoreState>((set, get) => ({
  providers:   [],
  bindings:    {},
  models:      [],
  modelsStatus: 'idle',
  loading:     false,
  error:       null,

  async loadAll() {
    set({ loading: true, error: null });
    try {
      const [providers, bindings] = await Promise.all([
        providersApi.list(),
        providersApi.listBindings(),
      ]);
      set({
        providers: [...providers],
        bindings: indexBindings(bindings),
        loading: false,
      });
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : '加载 Provider 配置失败',
        loading: false,
      });
    }
    // 模型目录有自己的状态机，失败不拖垮 Provider/绑定。
    void get().loadModels();
  },

  async refreshProviders() {
    try {
      const providers = await providersApi.list();
      set({ providers: [...providers] });
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '刷新 Provider 失败' });
    }
  },

  async refreshBindings() {
    try {
      const bindings = await providersApi.listBindings();
      set({ bindings: indexBindings(bindings) });
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '刷新模型绑定失败' });
    }
  },

  async loadModels(force = false) {
    if (!force && get().modelsStatus === 'ready') return;
    if (modelsLoadPromise) return modelsLoadPromise;

    set({ modelsStatus: 'loading', error: null });
    modelsLoadPromise = providersApi.listAvailable('llm')
      .then(({ models }) => {
        set({ models: [...models], modelsStatus: 'ready', error: null });
      })
      .catch((error: unknown) => {
        set({
          modelsStatus: 'error',
          error: error instanceof Error ? error.message : '加载模型目录失败',
        });
      })
      .finally(() => {
        modelsLoadPromise = null;
      });
    return modelsLoadPromise;
  },

  async createProvider(input) {
    try {
      await providersApi.create(input);
      await get().refreshProviders();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '创建 Provider 失败' });
      throw err;
    }
  },

  async patchProvider(id, patch) {
    try {
      await providersApi.patch(id, patch);
      await get().refreshProviders();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '更新 Provider 失败' });
      throw err;
    }
  },

  async deleteProvider(id) {
    try {
      await providersApi.remove(id);
      await get().refreshProviders();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '删除 Provider 失败' });
      throw err;
    }
  },

  async upsertBinding(module, input) {
    try {
      const binding = await providersApi.setBinding(module, input);
      if (binding) set((s) => ({ bindings: { ...s.bindings, [module]: binding } }));
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '保存模型绑定失败' });
      throw err;
    }
  },

  async deleteBinding(module) {
    try {
      await providersApi.deleteBinding(module);
      set((s) => {
        const bindings = { ...s.bindings };
        delete bindings[module];
        return { bindings };
      });
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '删除模型绑定失败' });
      throw err;
    }
  },
}));

function indexBindings(list: BindingsList): Partial<Record<BindingModule, BindingsList[number]>> {
  const out: Partial<Record<BindingModule, BindingsList[number]>> = {};
  for (const binding of list) out[binding.module] = binding;
  return out;
}

/** 按 providerId + modelId 在可用目录里精确查找已启用模型。 */
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
