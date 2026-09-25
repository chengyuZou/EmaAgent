// Provider 事实族单一入口：Provider 配置与业务位模型绑定。
// 只存同窗口多组件订阅的两份共享状态；可用模型目录这类查询由各消费方直接调 API。
import { create } from 'zustand';
import type { AppEvent } from '@ema-agent/server/application/appEvents.js';
import {
  providersApi,
  type ProviderRecord,
  type ProviderDetail,
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

  createProvider(input: ProviderConfigInput): Promise<ProviderDetail>;
  deleteProvider(id: string):                         Promise<void>;

  upsertBinding(module: BindingModule, input: BindingUpsertInput): Promise<void>;
  deleteBinding(module: BindingModule):               Promise<void>;
}

let providersRequest = 0;
let bindingsRequest = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshRunning = false;
let providersPending = false;
let bindingsPending = false;

export const useProviderStore = create<ProviderStoreState>((set, get) => ({
  providers:   [],
  bindings:    {},

  async loadAll() {
    await Promise.all([
      get().refreshProviders(),
      get().refreshBindings(),
    ]);
  },

  async refreshProviders() {
    const request = ++providersRequest;
    const providers = await providersApi.list();
    if (request === providersRequest) set({ providers: [...providers] });
  },

  async refreshBindings() {
    const request = ++bindingsRequest;
    const bindings = await providersApi.listBindings();
    if (request === bindingsRequest) set({ bindings: indexBindings(bindings) });
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

export function handleProviderSystemEvent(event: AppEvent): void {
  if (
    event.type === 'provider_config_changed'
    || event.type === 'provider_models_changed'
    || event.type === 'provider_health_changed'
  ) {
    providersPending = true;
  } else if (event.type === 'model_bindings_changed') {
    bindingsPending = true;
  } else {
    return;
  }
  if (refreshTimer !== null || refreshRunning) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshPendingProviderData();
  }, 150);
}

async function refreshPendingProviderData(): Promise<void> {
  if (refreshRunning) return;
  refreshRunning = true;
  try {
    while (providersPending || bindingsPending) {
      const refreshProviders = providersPending;
      const refreshBindings = bindingsPending;
      providersPending = false;
      bindingsPending = false;
      const results = await Promise.allSettled([
        refreshProviders ? useProviderStore.getState().refreshProviders() : Promise.resolve(),
        refreshBindings ? useProviderStore.getState().refreshBindings() : Promise.resolve(),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') console.warn('[providers] 跨窗口刷新失败:', result.reason);
      }
    }
  } finally {
    refreshRunning = false;
  }
}

function indexBindings(list: BindingsList): Partial<Record<BindingModule, BindingsList[number]>> {
  const out: Partial<Record<BindingModule, BindingsList[number]>> = {};
  for (const binding of list) out[binding.module] = binding;
  return out;
}
