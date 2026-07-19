// 在每个桌面窗口加载运行时设置，并接收其他窗口保存后的同步广播。
import { useEffect } from 'react';
import {
  RUNTIME_SETTINGS_EVENT,
  useSettingsStore,
  type RuntimeSettingsPayload,
} from './settings-store.js';
import { tauriBridge } from '../lib/tauri-bridge.js';

export function useRuntimeSettingsSync(sidecarReady: boolean): void {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void tauriBridge.listen<RuntimeSettingsPayload>(RUNTIME_SETTINGS_EVENT, ({ payload }) => {
      useSettingsStore.setState({
        permissionTimeoutMs: payload.permissionTimeoutMs,
        eventDisplay: payload.eventDisplay,
      });
    }).then((release) => {
      if (disposed) release();
      else unlisten = release;
    }).catch((error: unknown) => {
      console.warn('[settings] failed to listen for runtime settings', error);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!sidecarReady) return;
    void useSettingsStore.getState().refreshRuntimeSettings().catch(() => {});
  }, [sidecarReady]);
}
