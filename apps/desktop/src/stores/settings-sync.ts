// 在每个桌面窗口加载运行时设置，并接收其他窗口保存后的同步广播。
import { useEffect } from 'react';
import { useSettingsStore } from './settings.js';
import { tauriBridge } from '../lib/tauri-bridge.js';

export function useSettingsSync(serverReady: boolean): void {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void tauriBridge.listenDesktopSettingsChanged((payload) => {
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
    if (!serverReady) return;
    void useSettingsStore.getState().refreshDesktopSettings().catch(() => {});
  }, [serverReady]);
}
