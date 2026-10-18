import { useEffect, useRef, useState } from 'react';
import { MainView, useMainNavigationStore } from '../layout/navigation.js';
import { tauriBridge } from './tauri/tauriBridge.js';
import { showToast } from './notifications/toast.js';

type FileDropTarget = 'chat' | 'settings-wallpaper';

function isCurrentTarget(target: FileDropTarget): boolean {
  const navigation = useMainNavigationStore.getState();
  if (target === 'chat') {
    return navigation.activeView === MainView.Chat;
  }
  return navigation.activeView === MainView.Settings
    && navigation.settingsTab === 'appearance-wallpapers';
}

export function useFileDrop(
  target: FileDropTarget,
  onDrop: (paths: readonly string[]) => Promise<void>,
  enabled = true,
) {
  const active = useMainNavigationStore(state => target === 'chat'
    ? state.activeView === MainView.Chat
    : state.activeView === MainView.Settings && state.settingsTab === 'appearance-wallpapers');
  const dropAreaRef = useRef<HTMLElement | null>(null);
  const onDropRef = useRef(onDrop);
  const [overlayWidth, setOverlayWidth] = useState<number | null>(null);
  onDropRef.current = onDrop;

  useEffect(() => {
    setOverlayWidth(null);
    if (!active || !enabled) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const reportError = (error: unknown): void => {
      showToast(error instanceof Error ? error.message : '读取拖入文件失败', { variant: 'danger' });
    };

    void tauriBridge.listenFileDrag(event => {
      // 隐藏页面仍保留尺寸, 原生事件也不受 pointer-events 或 inert 限制.
      // 在事件到达时读取导航, 避免页面切换到 effect 清理之间把文件交给后台页面.
      if (disposed || !isCurrentTarget(target)) return;
      if (event.type === 'leave') {
        setOverlayWidth(null);
        return;
      }
      const element = dropAreaRef.current;
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      const column = target === 'chat'
        ? element.querySelector<HTMLElement>('[data-ema-chat-column]')
        : null;
      const right = column?.getBoundingClientRect().right ?? bounds.right;
      const inside = event.x >= bounds.left && event.x < right
        && event.y >= bounds.top && event.y < bounds.bottom;
      if (event.type === 'drop') {
        setOverlayWidth(null);
        // 接收时固定处理函数, 文件读取期间切换页面或 Session 不会把结果改投别处.
        if (inside) void onDropRef.current(event.paths).catch(reportError);
      } else {
        setOverlayWidth(inside ? right - bounds.left : null);
      }
    }).then(stop => {
      if (disposed) {
        stop();
      } else {
        unlisten = stop;
      }
    }).catch(reportError);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [active, enabled, target]);

  return { dropAreaRef, overlayWidth: active && enabled ? overlayWidth : null };
}
