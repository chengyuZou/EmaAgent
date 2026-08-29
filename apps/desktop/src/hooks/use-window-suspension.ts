// 汇合 Tauri 窗口显隐与浏览器页面可见性，向桌宠舞台提供统一暂停状态。
import { useEffect, useState } from 'react';
import { tauriBridge } from '../lib/tauri-bridge.js';

export function resolveWindowSuspended(
  documentHidden: boolean,
  hostVisible: boolean,
  hostManagesVisibility = false,
): boolean {
  return hostManagesVisibility ? !hostVisible : documentHidden || !hostVisible;
}

export function useWindowSuspension(): boolean {
  const [documentHidden, setDocumentHidden] = useState(
    () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  );
  const [hostVisible, setHostVisible] = useState(true);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const updateDocumentVisibility = (): void => {
      setDocumentHidden(document.visibilityState === 'hidden');
    };
    document.addEventListener('visibilitychange', updateDocumentVisibility);
    updateDocumentVisibility();
    return () => document.removeEventListener('visibilitychange', updateDocumentVisibility);
  }, []);

  useEffect(() => {
    if (!tauriBridge.isTauri()) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void tauriBridge.isWindowVisible().then((visible) => {
      if (!disposed && visible !== null) setHostVisible(visible);
    });

    void tauriBridge.listenWindowVisibility((visible) => {
      if (!disposed) setHostVisible(visible);
    }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return resolveWindowSuspended(documentHidden, hostVisible, tauriBridge.isTauri());
}
