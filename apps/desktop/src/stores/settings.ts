// 运行时设置通道：permission 等待超时与事件展示配置，保存后广播同步其他桌面窗口。
// 两个值键（permission.askTimeoutMs / frontend.eventDisplay）走 settings 值 API，不再有专用端点。
import { create } from 'zustand';
import { settingsApi, type EventDisplayTable } from '../api/settings.js';
import { tauriBridge } from '../lib/tauri-bridge.js';

/** 单个事件类型的展示配置（生效表 = 默认表 + 用户覆盖合并）。 */
export type EventDisplayConfig = EventDisplayTable[string];

const PERMISSION_ASK_TIMEOUT_KEY = 'permission.askTimeoutMs';
const EVENT_DISPLAY_SETTING_KEY = 'frontend.eventDisplay';

export const RUNTIME_SETTINGS_EVENT = 'settings:runtime-changed';

export interface RuntimeSettingsPayload {
  /** 批准卡与问询卡等待超时（毫秒）；null = 一直等待。 */
  permissionTimeoutMs: number | null;
  eventDisplay: EventDisplayTable | null;
}

export interface SettingsStoreState {
  permissionTimeoutMs: number | null;
  /** 生效的事件展示配置（默认表与用户覆盖已合并）。 */
  eventDisplay:        EventDisplayTable | null;
  error:               string | null;

  putPermissionTimeout(ms: number | null):             Promise<void>;
  refreshRuntimeSettings():                            Promise<void>;

  /** 从服务端重读完整事件展示配置。 */
  refreshEventDisplay():                              Promise<void>;
  /** 保存指定事件类型的用户覆盖；与既有覆盖合并（生效投影不回写，防止默认值被冻结成覆盖）。 */
  putEventDisplay(overrides: Record<string, EventDisplayConfig>): Promise<void>;
}

export const useSettingsStore = create<SettingsStoreState>((set, get) => ({
  permissionTimeoutMs: null,
  eventDisplay:        null,
  error:               null,

  async putPermissionTimeout(ms) {
    try {
      await settingsApi.putValue(PERMISSION_ASK_TIMEOUT_KEY, ms);
      set({ permissionTimeoutMs: ms, error: null });
      broadcastRuntimeSettings(get());
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '保存批准超时失败' });
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
      set({ error: err instanceof Error ? err.message : '加载运行时设置失败' });
      throw err;
    }
  },

  async refreshEventDisplay() {
    try {
      const eventDisplay = await settingsApi.getEventDisplay();
      set({ eventDisplay, error: null });
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '加载事件展示配置失败' });
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
      set({ error: err instanceof Error ? err.message : '保存事件展示配置失败' });
      throw err;
    }
  },
}));

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
    console.warn('[settings] 广播运行时设置失败', error);
  });
}
