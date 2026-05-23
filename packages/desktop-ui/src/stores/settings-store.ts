/**
 * Settings store — providers + bindings + settings cache (write-through).
 */
import { create } from 'zustand';
import { providersApi, type ProviderConfigWire, type ProviderConfigInput, type ProviderDefinitionWire, type ProbeResultWire } from '../api/providers.js';
import { modelBindingsApi, type BindingModule, type ResolvedModelBinding, type BindingUpsertInput } from '../api/model-bindings.js';
import { settingsApi, type TtsFallbackSettings } from '../api/settings.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SettingsStoreState {
  providers:           ProviderConfigWire[];
  providerDefinitions: ProviderDefinitionWire[];
  bindings:            Partial<Record<BindingModule, ResolvedModelBinding[]>>;
  ttsFallback:         TtsFallbackSettings | null;
  permissionTimeoutMs: number;
  loading:             boolean;
  error:               string | null;

  loadAll():                                          Promise<void>;
  refreshProviders():                                 Promise<void>;
  refreshBindings(module: BindingModule):             Promise<void>;

  upsertProvider(input: ProviderConfigInput, id?: string): Promise<void>;
  deleteProvider(id: string):                         Promise<void>;
  probeProvider(id: string, model?: string):          Promise<ProbeResultWire>;

  upsertBinding(module: BindingModule, input: BindingUpsertInput): Promise<void>;
  deleteBinding(module: BindingModule, providerConfigId: string, model: string): Promise<void>;

  putTtsFallback(payload: TtsFallbackSettings | null): Promise<void>;
  putPermissionTimeout(ms: number):                    Promise<void>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useSettingsStore = create<SettingsStoreState>((set, get) => ({
  providers:           [],
  providerDefinitions: [],
  bindings:            {},
  ttsFallback:         null,
  permissionTimeoutMs: 120_000,
  loading:             false,
  error:               null,

  async loadAll() {
    set({ loading: true, error: null });
    try {
      const [definitions, providers, ttsResult, permResult] = await Promise.all([
        providersApi.listDefinitions(),
        providersApi.list(),
        settingsApi.getTtsFallback().catch(() => ({ fallback: null })),
        settingsApi.getPermissionTimeout().catch(() => ({ timeoutMs: 120_000 })),
      ]);
      set({
        providerDefinitions: definitions,
        providers,
        ttsFallback: ttsResult.fallback,
        permissionTimeoutMs: permResult.timeoutMs,
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
        await providersApi.patch(id, input);
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

  async probeProvider(id, model) {
    return providersApi.probe(id, model);
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

  async putTtsFallback(payload) {
    try {
      if (payload === null) {
        await settingsApi.deleteTtsFallback();
        set({ ttsFallback: null });
      } else {
        await settingsApi.putTtsFallback(payload);
        set({ ttsFallback: payload });
      }
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to save TTS fallback' });
      throw err;
    }
  },

  async putPermissionTimeout(ms) {
    try {
      await settingsApi.putPermissionTimeout({ timeoutMs: ms });
      set({ permissionTimeoutMs: ms });
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to save permission timeout' });
      throw err;
    }
  },
}));
