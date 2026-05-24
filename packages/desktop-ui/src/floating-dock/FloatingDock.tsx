/**
 * FloatingDock — main-window right-side floating button column.
 *
 * Buttons: chat, settings, expression (cycle), pin, passthrough, quit.
 * Uses tauriBridge for window control instead of apps/desktop's invokeWindow.
 */
import { useState } from 'react';
import { useUiStore } from '../stores/ui-store.js';
import { tauriBridge } from '../lib/tauri-bridge.js';

export interface FloatingDockProps {
  visible: boolean;
}

export function FloatingDock({ visible }: FloatingDockProps): JSX.Element {
  const dockVisible = useUiStore((s) => s.dockVisible);
  const show = visible || dockVisible;

  // Toggle state — tracks current on/off for Tauri window flags
  const [pinned,      setPinned]      = useState(true);
  const [passthrough, setPassthrough] = useState(false);

  const buttons = [
    { id: 'chat',       icon: '💬', label: '聊天',
      onClick: () => tauriBridge.openWindow('chat') },
    { id: 'settings',   icon: '⚙',  label: '设置',
      onClick: () => tauriBridge.openWindow('settings') },
    { id: 'expression', icon: '😊', label: '切换表情',
      onClick: () => tauriBridge.emit('stage:cycle-expression') },
    {
      id: 'pin',
      icon:  pinned ? '📌' : '📍',
      label: pinned ? '取消置顶' : '置顶',
      active: pinned,
      onClick: async () => {
        const next = !pinned;
        setPinned(next);
        await tauriBridge.setAlwaysOnTop(next);
      },
    },
    {
      id: 'passthrough',
      icon:  passthrough ? '👆' : '🖱️',
      label: passthrough ? '关闭穿透' : '点击穿透',
      active: passthrough,
      onClick: async () => {
        const next = !passthrough;
        setPassthrough(next);
        await tauriBridge.setPassthrough(next);
      },
    },
    { id: 'quit', icon: '⏻', label: '退出', danger: true,
      onClick: () => tauriBridge.quit() },
  ];

  return (
    <div
      data-tauri-drag-region="false"
      className={`absolute right-3 top-1/2 -translate-y-1/2 z-10 flex flex-col gap-2 transition-opacity duration-200 ${
        show ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
    >
      {buttons.map((btn) => (
        <button
          key={btn.id}
          data-tauri-drag-region="false"
          className={[
            'w-10 h-10 rounded-full backdrop-blur border flex items-center justify-center text-sm transition-all group relative',
            btn.active
              ? 'bg-pink-400/30 border-pink-400/60'
              : btn.danger
              ? 'bg-gray-800/80 border-gray-600/50 hover:bg-red-500/40 hover:border-red-400/60'
              : 'bg-gray-800/80 border-gray-600/50 hover:bg-gray-700/80 hover:border-pink-400/30',
          ].join(' ')}
          onClick={() => void btn.onClick()}
          aria-label={btn.label}
          title={btn.label}
        >
          <span>{btn.icon}</span>
          <span className="absolute right-full mr-3 px-2 py-1 rounded-lg bg-gray-900 text-xs text-gray-300 opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap transition-opacity">
            {btn.label}
          </span>
        </button>
      ))}
    </div>
  );
}
