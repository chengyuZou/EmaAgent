// 管理 Provider、模型绑定与运行时设置，并在保存后同步其他桌面窗口。
import { create } from 'zustand';
import { providersApi, type ProviderConfigWire, type ProviderConfigInput, type ProviderDefinition } from '../api/providers.js';
import { modelBindingsApi, type BindingModule, type ResolvedModelBinding, type BindingUpsertInput } from '../api/model-bindings.js';
import { settingsApi, type EventDisplayConfig, type EventDisplayResult } from '../api/settings.js';
import { tauriBridge } from '../lib/tauri-bridge.js';

export type { EventDisplayConfig, EventDisplayResult };

export const RUNTIME_SETTINGS_EVENT = 'settings:runtime-changed';

export interface RuntimeSettingsPayload {
  permissionTimeoutMs: number;
  eventDisplay: EventDisplayResult | null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SettingsStoreState {
  providers:           ProviderConfigWire[];
  providerDefinitions: ProviderDefinition[];
  bindings:            Partial<Record<BindingModule, ResolvedModelBinding[]>>;
  permissionTimeoutMs: number;
  /** Effective event-display config (defaults merged with user overrides). */
  eventDisplay:        EventDisplayResult | null;
  loading:             boolean;
  error:               string | null;

  loadAll():                                          Promise<void>;
  refreshProviders():                                 Promise<void>;
  refreshBindings(module: BindingModule):             Promise<void>;

  upsertProvider(input: ProviderConfigInput, id?: string): Promise<void>;
  deleteProvider(id: string):                         Promise<void>;

  upsertBinding(module: BindingModule, input: BindingUpsertInput): Promise<void>;
  deleteBinding(module: BindingModule, providerConfigId: string, model: string): Promise<void>;

  putPermissionTimeout(ms: number):                    Promise<void>;
  refreshRuntimeSettings():                            Promise<void>;

  /** Reload the full event-display config from the sidecar. */
  refreshEventDisplay():                              Promise<void>;
  /** Persist user overrides for specific event types. Merges with existing overrides. */
  putEventDisplay(overrides: Record<string, EventDisplayConfig>): Promise<void>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useSettingsStore = create<SettingsStoreState>((set, get) => ({
  providers:           [],
  providerDefinitions: [],
  bindings:            {},
  permissionTimeoutMs: 120_000,
  eventDisplay:        null,
  loading:             false,
  error:               null,

  async loadAll() {
    set({ loading: true, error: null });
    try {
      const [definitions, providers, permResult, eventDisplay] = await Promise.all([
        providersApi.listDefinitions(),
        providersApi.list(),
        settingsApi.getPermissionTimeout().catch(() => ({ timeoutMs: 120_000 })),
        settingsApi.getEventDisplay().catch(() => null),
      ]);
      set({
        providerDefinitions: definitions,
        providers,
        permissionTimeoutMs: permResult.timeoutMs,
        eventDisplay,
        loading: false,
      });
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : 'Failed to load settings',
        loading: false,
      });
    }
  },

  async refreshProviders() {
    try {
      const providers = await providersApi.list();
      set({ providers });
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to refresh providers' });
    }
  },

  async refreshBindings(module: BindingModule) {
    try {
      const list = await modelBindingsApi.listByModule(module);
      set((s) => ({ bindings: { ...s.bindings, [module]: list } }));
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to refresh bindings' });
    }
  },

  async upsertProvider(input, id) {
    try {
      if (id) {
        const { apiKey, definitionId: _definitionId, ...fields } = input;
        await providersApi.patch(id, {
          ...fields,
          credential: apiKey === undefined
            ? { type: 'keep' }
            : apiKey.trim()
              ? { type: 'replace', value: apiKey.trim() }
              : { type: 'clear' },
        });
      } else {
        await providersApi.create(input);
      }
      await get().refreshProviders();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to save provider' });
      throw err;
    }
  },

  async deleteProvider(id) {
    try {
      await providersApi.delete(id);
      await get().refreshProviders();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete provider' });
      throw err;
    }
  },

  async upsertBinding(module, input) {
    try {
      const list = await modelBindingsApi.upsert(module, input);
      set((s) => ({ bindings: { ...s.bindings, [module]: list } }));
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to save binding' });
      throw err;
    }
  },

  async deleteBinding(module, providerConfigId, model) {
    try {
      await modelBindingsApi.delete(module, providerConfigId, model);
      await get().refreshBindings(module);
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete binding' });
      throw err;
    }
  },

  async putPermissionTimeout(ms) {
    try {
      await settingsApi.putPermissionTimeout({ timeoutMs: ms });
      set({ permissionTimeoutMs: ms, error: null });
      broadcastRuntimeSettings(get());
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to save permission timeout' });
      throw err;
    }
  },

  async refreshRuntimeSettings() {
    try {
      const [permission, eventDisplay] = await Promise.all([
        settingsApi.getPermissionTimeout(),
        settingsApi.getEventDisplay(),
      ]);
      set({
        permissionTimeoutMs: permission.timeoutMs,
        eventDisplay,
        error: null,
      });
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to load runtime settings' });
      throw err;
    }
  },

  async refreshEventDisplay() {
    try {
      const eventDisplay = await settingsApi.getEventDisplay();
      set({ eventDisplay, error: null });
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to load event display config' });
      throw err;
    }
  },

  async putEventDisplay(overrides) {
    try {
      const current = get().eventDisplay;
      if (!current) throw new Error('事件展示设置尚未加载');
      await settingsApi.putEventDisplay(overrides);
      set({
        eventDisplay: {
          defaults: current.defaults,
          overrides,
          effective: { ...current.defaults, ...overrides },
        },
        error: null,
      });
      broadcastRuntimeSettings(get());
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to save event display config' });
      throw err;
    }
  },
}));

function broadcastRuntimeSettings(state: SettingsStoreState): void {
  const payload: RuntimeSettingsPayload = {
    permissionTimeoutMs: state.permissionTimeoutMs,
    eventDisplay: state.eventDisplay,
  };
  void tauriBridge.emit(RUNTIME_SETTINGS_EVENT, payload).catch((error: unknown) => {
    console.warn('[settings] failed to broadcast runtime settings', error);
  });
}
