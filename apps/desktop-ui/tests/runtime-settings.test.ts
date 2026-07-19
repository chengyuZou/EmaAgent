// 测试运行时设置的权威刷新、覆盖替换、跨窗口广播和事件通知解析。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsApi, type EventDisplayResult } from '../src/api/settings.js';
import {
  resolveConfiguredEventNotification,
} from '../src/lib/event-notifications.js';
import { tauriBridge } from '../src/lib/tauri-bridge.js';
import { useSettingsStore } from '../src/stores/settings-store.js';

const eventDisplay: EventDisplayResult = {
  defaults: {
    system_warning: { enabled: true, color: '#f59e0b', durationMs: 5000 },
    tool_result: { enabled: true, color: '#22c55e', durationMs: 3000 },
  },
  overrides: {
    system_warning: { enabled: false, color: '#f59e0b', durationMs: 5000 },
  },
  effective: {
    system_warning: { enabled: false, color: '#f59e0b', durationMs: 5000 },
    tool_result: { enabled: true, color: '#22c55e', durationMs: 3000 },
  },
};

beforeEach(() => {
  useSettingsStore.setState({
    permissionTimeoutMs: 120_000,
    eventDisplay: null,
    error: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('运行时设置 Store', () => {
  it('一次刷新同时更新权限等待时间和事件配置', async () => {
    vi.spyOn(settingsApi, 'getPermissionTimeout').mockResolvedValue({ timeoutMs: 45_000 });
    vi.spyOn(settingsApi, 'getEventDisplay').mockResolvedValue(eventDisplay);

    await useSettingsStore.getState().refreshRuntimeSettings();

    expect(useSettingsStore.getState()).toMatchObject({
      permissionTimeoutMs: 45_000,
      eventDisplay,
      error: null,
    });
  });

  it('保存事件覆盖时按完整快照替换，允许真正恢复默认值', async () => {
    useSettingsStore.setState({ eventDisplay });
    const put = vi.spyOn(settingsApi, 'putEventDisplay').mockResolvedValue();
    const emit = vi.spyOn(tauriBridge, 'emit').mockResolvedValue();
    const replacement = {
      tool_result: { enabled: false, color: '#22c55e', durationMs: 3000 },
    };

    await useSettingsStore.getState().putEventDisplay(replacement);

    expect(put).toHaveBeenCalledWith(replacement);
    expect(useSettingsStore.getState().eventDisplay).toMatchObject({
      overrides: replacement,
      effective: {
        system_warning: eventDisplay.defaults.system_warning,
        tool_result: replacement.tool_result,
      },
    });
    expect(emit).toHaveBeenCalledWith('settings:runtime-changed', expect.any(Object));
  });

  it('保存权限等待时间后更新本窗口并广播其他窗口', async () => {
    vi.spyOn(settingsApi, 'putPermissionTimeout').mockResolvedValue();
    const emit = vi.spyOn(tauriBridge, 'emit').mockResolvedValue();

    await useSettingsStore.getState().putPermissionTimeout(60_000);

    expect(useSettingsStore.getState().permissionTimeoutMs).toBe(60_000);
    expect(emit).toHaveBeenCalledWith('settings:runtime-changed', expect.objectContaining({
      permissionTimeoutMs: 60_000,
    }));
  });
});

describe('事件通知解析', () => {
  it('关闭的事件不会生成通知', () => {
    expect(resolveConfiguredEventNotification(
      { type: 'system_warning', level: 'warn', message: 'offline' },
      { enabled: false, color: '#f59e0b', durationMs: 5000 },
    )).toBeNull();
  });

  it('应用强调色、停留时间与文本截断', () => {
    expect(resolveConfiguredEventNotification(
      { type: 'system_warning', level: 'warn', message: '123456789' },
      { enabled: true, color: '#abcdef', durationMs: null, truncateChars: 5 },
    )).toEqual({
      message: '12345…',
      variant: 'warning',
      duration: null,
      accentColor: '#abcdef',
    });
  });
});
