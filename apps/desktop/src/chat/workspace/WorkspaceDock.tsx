// 右侧/底部共用的工作区 Dock：标签条、内容容器、拖拽手柄与居中启动器。
import { useCallback, useRef, useState, type JSX } from 'react';

import { useWorkspaceStore } from '../../stores/workspaceStore.js';
import { WorkspaceTabBar } from './WorkspaceTabBar.js';
import { WorkspaceLauncher } from './WorkspaceLauncher.js';
import type { WorkspaceDockId } from '../../stores/workspaceTypes.js';

export interface WorkspaceDockProps {
  sessionId: string | null;
  dock: WorkspaceDockId;
  /** 内容容器回调：WorkspaceFrame 的标签池经 portal 挂载到这里。
   *  容器常驻（折叠时仅尺寸为 0），标签内部状态不因折叠丢失。 */
  contentRef: (el: HTMLDivElement | null) => void;
  /** RightDock 全宽展开（§3.5）：占满 WorkspaceFrame 宽度。 */
  fullWidth?: boolean;
  /** 放大按钮回调；仅 Dock 展开且有内容时传入（按钮才渲染）。 */
  onExpandFullWidth?: () => void;
}

export function WorkspaceDock({
  sessionId, dock, contentRef, fullWidth = false, onExpandFullWidth,
}: WorkspaceDockProps): JSX.Element {
  const layout = useWorkspaceStore((s) =>
    sessionId ? s.layouts[sessionId as string] : undefined);
  const rightWidth = useWorkspaceStore((s) => s.rightWidth);
  const bottomHeight = useWorkspaceStore((s) => s.bottomHeight);
  const setRightWidth = useWorkspaceStore((s) => s.setRightWidth);
  const setBottomHeight = useWorkspaceStore((s) => s.setBottomHeight);

  const open = dock === 'right' ? (layout?.rightOpen ?? false) : (layout?.bottomOpen ?? false);
  const order = dock === 'right' ? (layout?.rightTabOrder ?? []) : (layout?.bottomTabOrder ?? []);
  const activeTabId = dock === 'right' ? layout?.activeRightTabId : layout?.activeBottomTabId;
  const tabs = order.map((id) => layout?.tabsById[id]).filter((t) => t !== undefined);

  const [launcherOverlay, setLauncherOverlay] = useState(false);
  const [resizing, setResizing] = useState(false);
  const resizeStartPos = useRef(0);
  const resizeStartSize = useRef(0);

  // 右 Dock：手柄在左边缘，向左拖增宽；底部 Dock：手柄在上边缘，向上拖增高。
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setResizing(true);
    const horizontal = dock === 'right';
    resizeStartPos.current = horizontal ? e.clientX : e.clientY;
    resizeStartSize.current = horizontal ? rightWidth : bottomHeight;
    document.body.classList.add(horizontal ? 'ema-resizing' : 'ema-resizing-v');
    const onMove = (ev: MouseEvent): void => {
      const delta = resizeStartPos.current - (horizontal ? ev.clientX : ev.clientY);
      if (horizontal) setRightWidth(resizeStartSize.current + delta);
      else setBottomHeight(resizeStartSize.current + delta);
    };
    const onUp = (): void => {
      setResizing(false);
      document.body.classList.remove(horizontal ? 'ema-resizing' : 'ema-resizing-v');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [dock, rightWidth, bottomHeight, setRightWidth, setBottomHeight]);

  const horizontal = dock === 'right';
  const sizeStyle = horizontal
    ? { width: fullWidth ? '100%' : open ? rightWidth : 0 }
    : { height: open ? bottomHeight : 0 };

  return (
    <div
      style={sizeStyle}
      className={`relative flex-none flex flex-col overflow-hidden bg-[var(--ema-surface-1)] ${
        horizontal ? 'border-l' : 'border-t'
      } ${open ? 'border-[var(--ema-border)]' : 'border-transparent'} ${
        resizing ? '' : horizontal ? 'ema-transition-width' : 'ema-transition-height'
      }`}
    >
      {open && !fullWidth && (
        <div
          className={horizontal ? 'ema-resize-handle' : 'ema-resize-handle-h'}
          onMouseDown={onResizeStart}
          aria-hidden
        />
      )}

      {open && sessionId && tabs.length > 0 && (
        <WorkspaceTabBar
          sessionId={sessionId}
          dock={dock}
          tabs={tabs}
          {...(activeTabId !== undefined ? { activeTabId } : {})}
          onAdd={() => setLauncherOverlay(true)}
          {...(onExpandFullWidth !== undefined ? { onExpandFullWidth } : {})}
        />
      )}

      {/* 标签池 portal 目标：常驻，折叠时随容器尺寸为 0，不卸载。 */}
      <div ref={contentRef} className="flex-1 min-h-0 flex flex-col overflow-hidden" />

      {open && sessionId && tabs.length === 0 && (
        <WorkspaceLauncher sessionId={sessionId} dock={dock} />
      )}
      {open && sessionId && launcherOverlay && (
        <WorkspaceLauncher
          sessionId={sessionId}
          dock={dock}
          onClose={() => setLauncherOverlay(false)}
        />
      )}
    </div>
  );
}
