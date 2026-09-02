// Provider 事实族单一入口：Provider 配置与业务位模型绑定。
// 只存同窗口多组件订阅的两份共享状态；可用模型目录这类查询由各消费方直接调 API。
import { create } from 'zustand';
import {
  providersApi,
  type ProviderRecord,
  type ProviderConfigInput,
  type BindingModule,
  type BindingUpsertInput,
  type BindingsList,
} from '../api/providers.js';

export interface ProviderStoreState {
  providers:           ProviderRecord[];
  /** 一个业务位一条绑定；缺省模块表示跟随系统默认解析。 */
  bindings:            Partial<Record<BindingModule, BindingsList[number]>>;

  loadAll():                                          Promise<void>;
  refreshProviders():                                 Promise<void>;
  refreshBindings():                                  Promise<void>;

  createProvider(input: ProviderConfigInput): Promise<ProviderRecord>;
  deleteProvider(id: string):                         Promise<void>;

  upsertBinding(module: BindingModule, input: BindingUpsertInput): Promise<void>;
  deleteBinding(module: BindingModule):               Promise<void>;
}

export const useProviderStore = create<ProviderStoreState>((set, get) => ({
  providers:   [],
  bindings:    {},

  async loadAll() {
    const [providers, bindings] = await Promise.all([
      providersApi.list(),
      providersApi.listBindings(),
    ]);
    set({
      providers: [...providers],
      bindings: indexBindings(bindings),
    });
  },

  async refreshProviders() {
    const providers = await providersApi.list();
    set({ providers: [...providers] });
  },

  async refreshBindings() {
    const bindings = await providersApi.listBindings();
    set({ bindings: indexBindings(bindings) });
  },

  async createProvider(input) {
    const created = await providersApi.create(input);
    await get().refreshProviders();
    return created;
  },

  async deleteProvider(id) {
    await providersApi.remove(id);
    await get().refreshProviders();
  },

  async upsertBinding(module, input) {
    const binding = await providersApi.setBinding(module, input);
    if (binding) set((s) => ({ bindings: { ...s.bindings, [module]: binding } }));
  },

  async deleteBinding(module) {
    await providersApi.deleteBinding(module);
    set((s) => {
      const bindings = { ...s.bindings };
      delete bindings[module];
      return { bindings };
    });
  },
}));

function indexBindings(list: BindingsList): Partial<Record<BindingModule, BindingsList[number]>> {
  const out: Partial<Record<BindingModule, BindingsList[number]>> = {};
  for (const binding of list) out[binding.module] = binding;
  return out;
}
