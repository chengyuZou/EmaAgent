// 右侧/底部共用的工作区 Dock：标签条、内容容器、拖拽手柄与居中启动器。
import { useEffect, useState, type JSX } from 'react';

import { useDockTabs } from './dockTabs.js';
import { useDragResize } from '../../hooks/use-drag-resize.js';
import { DockTabBar } from './DockTabBar.js';
import { DockLauncher } from './DockLauncher.js';
import type { DockSide } from './dockTabs.js';

export interface DockProps {
  sessionId: string | null;
  dock: DockSide;
  /** 内容容器回调：ChatFrame 的标签池经 portal 挂载到这里。
   *  容器常驻（折叠时仅尺寸为 0），标签内部状态不因折叠丢失。 */
  contentRef: (el: HTMLDivElement | null) => void;
  /** RightDock 全宽展开：占满 ChatFrame 宽度。 */
  fullWidth?: boolean;
  /** 放大按钮回调；仅 Dock 展开且有内容时传入（按钮才渲染）。 */
  onExpandFullWidth?: () => void;
  /** 原生网页视图不能被 React 浮层覆盖，启动器打开时通知标签池先隐藏页面。 */
  onLauncherChange?: (open: boolean) => void;
}

export function Dock({
  sessionId, dock, contentRef, fullWidth = false, onExpandFullWidth, onLauncherChange,
}: DockProps): JSX.Element {
  const layout = useDockTabs((s) =>
    sessionId ? s.layouts[sessionId as string] : undefined);
  const rightWidth = useDockTabs((s) => s.rightWidth);
  const bottomHeight = useDockTabs((s) => s.bottomHeight);
  const setRightWidth = useDockTabs((s) => s.setRightWidth);
  const setBottomHeight = useDockTabs((s) => s.setBottomHeight);

  const open = dock === 'right' ? (layout?.rightOpen ?? false) : (layout?.bottomOpen ?? false);
  const order = dock === 'right' ? (layout?.rightTabOrder ?? []) : (layout?.bottomTabOrder ?? []);
  const activeTabId = dock === 'right' ? layout?.activeRightTabId : layout?.activeBottomTabId;
  const tabs = order.map((id) => layout?.tabsById[id]).filter((t) => t !== undefined);

  const [launcherOverlay, setLauncherOverlay] = useState(false);
  const setLauncher = (value: boolean): void => {
    setLauncherOverlay(value);
    onLauncherChange?.(value);
  };
  useEffect(() => {
    setLauncherOverlay(false);
    onLauncherChange?.(false);
  }, [sessionId, onLauncherChange]);

  // 右 Dock：手柄在左边缘，向左拖增宽；底部 Dock：手柄在上边缘，向上拖增高。
  const horizontal = dock === 'right';
  const { resizing, handleProps } = useDragResize({
    axis: horizontal ? 'x' : 'y',
    sign: -1,
    getSize: () => (horizontal ? rightWidth : bottomHeight),
    setSize: horizontal ? setRightWidth : setBottomHeight,
    min: horizontal ? 240 : 120,
    max: horizontal ? 720 : 480,
  });
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
          {...handleProps}
          aria-hidden
        />
      )}

      {open && sessionId && tabs.length > 0 && (
        <DockTabBar
          sessionId={sessionId}
          dock={dock}
          tabs={tabs}
          {...(activeTabId !== undefined ? { activeTabId } : {})}
          onAdd={() => setLauncher(true)}
          {...(onExpandFullWidth !== undefined ? { onExpandFullWidth } : {})}
        />
      )}

      {/* 标签池 portal 目标：常驻，折叠时随容器尺寸为 0，不卸载。 */}
      <div ref={contentRef} className="flex-1 min-h-0 flex flex-col overflow-hidden" />

      {open && sessionId && tabs.length === 0 && (
        <DockLauncher sessionId={sessionId} dock={dock} />
      )}
      {open && sessionId && launcherOverlay && (
        <DockLauncher
          sessionId={sessionId}
          dock={dock}
          onClose={() => setLauncher(false)}
        />
      )}
    </div>
  );
}
