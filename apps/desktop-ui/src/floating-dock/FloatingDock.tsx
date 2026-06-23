/**
 * FloatingDock — main-window bottom-right floating button column.
 *
 * Main column (top → bottom): more, expression, drag — anchored to the
 * window's bottom-right corner. The rest (chat / settings / pin / quit)
 * live in a flyout panel that expands UPWARD from the more button on
 * click, and collapses only when the more button is clicked again.
 */
import { useState, type CSSProperties } from 'react';
import { IconButton, Tooltip } from '@ema-agent/ui';
import { useUiStore } from '../stores/ui-store.js';
import { tauriBridge } from '../lib/tauri-bridge.js';

export interface FloatingDockProps {
  visible: boolean;
}

export function FloatingDock({ visible }: FloatingDockProps): JSX.Element {
  const dockVisible = useUiStore((s) => s.dockVisible);

  const [pinned,     setPinned]     = useState(true);
  const [flyoutOpen, setFlyoutOpen] = useState(false);

  const show = visible || dockVisible;

  // ── Flyout buttons (3 per row) ──────────────────────────────────────────
  const flyoutButtons = [
    { id: 'chat',     icon: 'i-mdi:chat-outline', label: '聊天',
      onClick: () => void tauriBridge.openWindow('chat') },
    { id: 'settings', icon: 'i-mdi:cog-outline',  label: '设置',
      onClick: () => void tauriBridge.openWindow('settings') },
    {
      id: 'pin',
      icon: pinned ? 'i-mdi:pin' : 'i-mdi:pin-off-outline',
      label: pinned ? '取消置顶' : '置顶',
      toggled: pinned,
      onClick: () => {
        const next = !pinned;
        setPinned(next);
        void tauriBridge.setAlwaysOnTop(next);
      },
    },
    { id: 'quit', icon: 'i-mdi:power', label: '退出', danger: true,
      onClick: () => void tauriBridge.quit() },
  ];

  return (
    <div
      data-tauri-drag-region="false"
      className={`absolute right-3 bottom-3 z-10 flex flex-col items-end gap-3 transition-opacity duration-200 ${
        show ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
    >
      {/* ── More (click-to-toggle, flyout expands upward like a drawer) ── */}
      <div className="relative">
        <div
          className={`absolute bottom-full right-0 mb-3 p-3 rounded-2xl border shadow-[var(--ema-shadow-3)] backdrop-blur grid grid-cols-[repeat(3,auto)] gap-3 origin-bottom-right transition-all duration-200 ease-out ${
            flyoutOpen
              ? 'opacity-100 translate-y-0 scale-100'
              : 'opacity-0 translate-y-3 scale-90 pointer-events-none'
          }`}
          style={{ background: 'var(--ema-surface-4)', borderColor: 'var(--ema-border)' }}
        >
          {flyoutButtons.map((btn, i) => (
            <Tooltip key={btn.id} content={btn.label} side="top">
              <IconButton
                size="md"
                label={btn.label}
                icon={btn.icon}
                toggled={btn.toggled}
                variant={btn.danger ? 'danger' : 'default'}
                className="rounded-xl ema-stagger-in"
                style={{ '--stagger-i': i } as CSSProperties}
                onClick={btn.onClick}
              />
            </Tooltip>
          ))}
        </div>

        <IconButton
          size="lg"
          label={flyoutOpen ? '收起' : '更多'}
          icon="i-mdi:dots-horizontal"
          toggled={flyoutOpen}
          className="rounded-full shadow-[var(--ema-shadow-1)] backdrop-blur"
          onClick={() => setFlyoutOpen((open) => !open)}
        />
      </div>

      {/* ── Expression ── */}
      <Tooltip content="切换表情" side="left">
        <IconButton
          size="lg"
          label="切换表情"
          icon="i-mdi:emoticon-happy-outline"
          className="rounded-full shadow-[var(--ema-shadow-1)] backdrop-blur"
          onClick={() => void tauriBridge.emit('stage:cycle-expression')}
        />
      </Tooltip>

      {/* ── Drag handle ── */}
      <Tooltip content="按住拖动" side="left">
        <IconButton
          size="lg"
          label="按住拖动"
          icon="i-mdi:drag"
          className="rounded-full shadow-[var(--ema-shadow-1)] backdrop-blur cursor-grab active:cursor-grabbing"
          onMouseDown={() => void tauriBridge.startDragging()}
        />
      </Tooltip>
    </div>
  );
}
