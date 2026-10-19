import { permissionAskTimeoutSetting, eventDisplaySetting } from '@ema-agent/server/settings';
import { create } from 'zustand';
import type { AppEvent } from '@ema-agent/server/application/appEvents.js';
import { settingsApi, type EventDisplayTable } from '../api/settings.js';
import { tauriBridge } from '../lib/tauri/tauriBridge.js';
import type { DesktopSettingsPayload } from '../lib/tauri/types.js';

/** 单个事件类型的展示配置(生效表 = 默认表 + 用户覆盖合并). */
export type EventDisplayConfig = EventDisplayTable[string];


export interface SettingsStoreState {
  permissionTimeoutMs: number | null;
  /** 生效的事件展示配置(默认表与用户覆盖已合并). */
  eventDisplay:        EventDisplayTable | null;
  error:               string | null;

  putPermissionTimeout(ms: number | null):             Promise<void>;
  refreshDesktopSettings():                            Promise<void>;

  /** 从服务端重读完整事件展示配置. */
  refreshEventDisplay():                              Promise<void>;
  /** 保存指定事件类型的用户覆盖; 与既有覆盖合并(生效投影不回写, 防止默认值被冻结成覆盖). */
  putEventDisplay(overrides: Record<string, EventDisplayConfig>): Promise<void>;
}

export const useSettingsStore = create<SettingsStoreState>((set, get) => ({
  permissionTimeoutMs: null,
  eventDisplay:        null,
  error:               null,

  async putPermissionTimeout(ms) {
    try {
      await settingsApi.putValue(permissionAskTimeoutSetting, ms);
      set({ permissionTimeoutMs: ms, error: null });
      broadcastDesktopSettings(get());
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '保存批准超时失败' });
      throw err;
    }
  },

  async refreshDesktopSettings() {
    try {
      const [permission, eventDisplay] = await Promise.all([
        settingsApi.getValue(permissionAskTimeoutSetting),
        settingsApi.getEventDisplay(),
      ]);
      set({
        permissionTimeoutMs: permission.value,
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
      // 合并必须发生在用户覆盖表上: getEventDisplay 返回的是含默认表的生效投影, 
      // 直接回写会把默认值冻结成用户覆盖.
      const current = await settingsApi.getValue(eventDisplaySetting);
      const base = current.value;
      await settingsApi.putValue(eventDisplaySetting, { ...base, ...overrides });
      await get().refreshEventDisplay();
      broadcastDesktopSettings(get());
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '保存事件展示配置失败' });
      throw err;
    }
  },
}));

function broadcastDesktopSettings(state: SettingsStoreState): void {
  const payload: DesktopSettingsPayload = {
    permissionTimeoutMs: state.permissionTimeoutMs,
    eventDisplay: state.eventDisplay,
  };
  void tauriBridge.publishDesktopSettingsChanged(payload).catch((error: unknown) => {
    console.warn('[settings] 广播桌面设置失败', error);
  });
}

export function handleSettingsSystemEvent(event: AppEvent): void {
  if (event.type === 'settings_changed') {
    void useSettingsStore.getState().refreshDesktopSettings().catch(() => {});
  }
}
