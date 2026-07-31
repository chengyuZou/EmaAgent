// 汇合 Tauri 窗口显隐与浏览器页面可见性，向桌宠舞台提供统一暂停状态。
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState } from 'react';

const WINDOW_VISIBILITY_EVENT = 'ema://window-visibility';

interface WindowVisibilityPayload {
  visible: boolean;
}

export function resolveWindowSuspended(documentHidden: boolean, hostVisible: boolean): boolean {
  return documentHidden || !hostVisible;
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
    // 普通浏览器预览没有 Tauri 注入对象，不能在 try/catch 之外直接取得当前窗口。
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;
    const currentWindow = getCurrentWindow();

    void currentWindow.isVisible()
      .then((visible) => {
        if (!disposed) setHostVisible(visible);
      })
      .catch(() => {
        // 普通浏览器预览没有 Tauri IPC，以页面可见性作为唯一信号。
      });

    void currentWindow.listen<WindowVisibilityPayload>(WINDOW_VISIBILITY_EVENT, (event) => {
      if (!disposed) setHostVisible(event.payload.visible);
    }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    }).catch(() => {
      // 普通浏览器预览没有 Tauri 事件总线。
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return resolveWindowSuspended(documentHidden, hostVisible);
}
