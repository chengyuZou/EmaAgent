// 管理 Provider、模型绑定与运行时设置，并在保存后同步其他桌面窗口。
// Provider/绑定走 providersApi；permission 超时与事件展示走 settings 值键
// （permission.askTimeoutMs / frontend.eventDisplay），不再有专用端点。
import { create } from 'zustand';
import {
  providersApi,
  type ProviderRecord,
  type ProviderConfigInput,
  type ProviderPatchInput,
  type BindingModule,
  type BindingUpsertInput,
  type BindingsList,
} from '../api/providers.js';
import { settingsApi, type EventDisplayTable } from '../api/settings.js';
import { tauriBridge } from '../lib/tauri-bridge.js';

/** 单个事件类型的展示配置（生效表 = 默认表 + 用户覆盖合并）。 */
export type EventDisplayConfig = EventDisplayTable[string];
export type { EventDisplayTable };

const PERMISSION_ASK_TIMEOUT_KEY = 'permission.askTimeoutMs';
const EVENT_DISPLAY_SETTING_KEY = 'frontend.eventDisplay';

export const RUNTIME_SETTINGS_EVENT = 'settings:runtime-changed';

export interface RuntimeSettingsPayload {
  /** 批准卡与问询卡等待超时（毫秒）；null = 一直等待。 */
  permissionTimeoutMs: number | null;
  eventDisplay: EventDisplayTable | null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SettingsStoreState {
  providers:           ProviderRecord[];
  /** 一个业务位一条绑定；缺省模块表示跟随系统默认解析。 */
  bindings:            Partial<Record<BindingModule, BindingsList[number]>>;
  permissionTimeoutMs: number | null;
  /** Effective event-display config (defaults merged with user overrides). */
  eventDisplay:        EventDisplayTable | null;
  loading:             boolean;
  error:               string | null;

  loadAll():                                          Promise<void>;
  refreshProviders():                                 Promise<void>;
  refreshBindings():                                  Promise<void>;

  createProvider(input: ProviderConfigInput):         Promise<void>;
  patchProvider(id: string, patch: ProviderPatchInput): Promise<void>;
  deleteProvider(id: string):                         Promise<void>;

  upsertBinding(module: BindingModule, input: BindingUpsertInput): Promise<void>;
  deleteBinding(module: BindingModule):               Promise<void>;

  putPermissionTimeout(ms: number | null):             Promise<void>;
  refreshRuntimeSettings():                            Promise<void>;

  /** Reload the full event-display config from the server. */
  refreshEventDisplay():                              Promise<void>;
  /** Persist user overrides for specific event types. Merges with existing overrides. */
  putEventDisplay(overrides: Record<string, EventDisplayConfig>): Promise<void>;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useSettingsStore = create<SettingsStoreState>((set, get) => ({
  providers:           [],
  bindings:            {},
  permissionTimeoutMs: null,
  eventDisplay:        null,
  loading:             false,
  error:               null,

  async loadAll() {
    set({ loading: true, error: null });
    try {
      const [providers, bindings, permResult, eventDisplay] = await Promise.all([
        providersApi.list(),
        providersApi.listBindings(),
        settingsApi.getValue(PERMISSION_ASK_TIMEOUT_KEY).catch(() => null),
        settingsApi.getEventDisplay().catch(() => null),
      ]);
      set({
        providers: [...providers],
        bindings: indexBindings(bindings),
        permissionTimeoutMs: readTimeoutValue(permResult?.value),
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
      set({ providers: [...providers] });
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to refresh providers' });
    }
  },

  async refreshBindings() {
    try {
      const bindings = await providersApi.listBindings();
      set({ bindings: indexBindings(bindings) });
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to refresh bindings' });
    }
  },

  async createProvider(input) {
    try {
      await providersApi.create(input);
      await get().refreshProviders();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to create provider' });
      throw err;
    }
  },

  async patchProvider(id, patch) {
    try {
      await providersApi.patch(id, patch);
      await get().refreshProviders();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to update provider' });
      throw err;
    }
  },

  async deleteProvider(id) {
    try {
      await providersApi.remove(id);
      await get().refreshProviders();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete provider' });
      throw err;
    }
  },

  async upsertBinding(module, input) {
    try {
      const binding = await providersApi.setBinding(module, input);
      if (binding) set((s) => ({ bindings: { ...s.bindings, [module]: binding } }));
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to save binding' });
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
      set({ error: err instanceof Error ? err.message : 'Failed to delete binding' });
      throw err;
    }
  },

  async putPermissionTimeout(ms) {
    try {
      await settingsApi.putValue(PERMISSION_ASK_TIMEOUT_KEY, ms);
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
        settingsApi.getValue(PERMISSION_ASK_TIMEOUT_KEY),
        settingsApi.getEventDisplay(),
      ]);
      set({
        permissionTimeoutMs: readTimeoutValue(permission.value),
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
      // 合并必须发生在用户覆盖表上：getEventDisplay 返回的是含默认表的生效投影，
      // 直接回写会把默认值冻结成用户覆盖。
      const current = await settingsApi.getValue(EVENT_DISPLAY_SETTING_KEY);
      const base = readOverridesValue(current.value);
      await settingsApi.putValue(EVENT_DISPLAY_SETTING_KEY, { ...base, ...overrides });
      await get().refreshEventDisplay();
      broadcastRuntimeSettings(get());
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to save event display config' });
      throw err;
    }
  },
}));

function indexBindings(list: BindingsList): Partial<Record<BindingModule, BindingsList[number]>> {
  const out: Partial<Record<BindingModule, BindingsList[number]>> = {};
  for (const binding of list) out[binding.module] = binding;
  return out;
}

/** 值键解码：number 或 null（一直等待）；其他形状按 null 处理。 */
function readTimeoutValue(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/** 用户覆盖表只接受对象；损坏形状当空表合并。 */
function readOverridesValue(value: unknown): Record<string, EventDisplayConfig> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, EventDisplayConfig>;
}

function broadcastRuntimeSettings(state: SettingsStoreState): void {
  const payload: RuntimeSettingsPayload = {
    permissionTimeoutMs: state.permissionTimeoutMs,
    eventDisplay: state.eventDisplay,
  };
  void tauriBridge.emit(RUNTIME_SETTINGS_EVENT, payload).catch((error: unknown) => {
    console.warn('[settings] failed to broadcast runtime settings', error);
  });
}
