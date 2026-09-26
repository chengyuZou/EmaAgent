// 提供桌宠主窗口的聊天、设置、置顶、表情、拖动与退出入口。
import { useState, type CSSProperties } from 'react';
import { IconButton, Popover, ScrollArea, Tooltip } from '@ema-agent/ui';
import { tauriBridge } from '../lib/tauri-bridge.js';
import { showToast } from '../lib/toast.js';

export interface FloatingDockProps {
  visible: boolean;
  expressionAvailable: boolean;
  expressions: readonly string[];
  selectedExpression: string | null;
  onSelectExpression(expression: string | null): void;
}

export function FloatingDock({
  visible,
  expressionAvailable,
  expressions,
  selectedExpression,
  onSelectExpression,
}: FloatingDockProps): JSX.Element {
  const [pinned,     setPinned]     = useState(true);
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const [pinUpdating, setPinUpdating] = useState(false);

  const show = visible;

  const runDockAction = (label: string, action: () => Promise<void>): void => {
    void action().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[floating-dock] ${label} failed`, error);
      showToast(`${label}失败：${detail}`, { variant: 'danger', duration: 6000 });
    });
  };

  // ── Flyout buttons (3 per row) ──────────────────────────────────────────
  const flyoutButtons = [
    { id: 'chat',     icon: 'i-mdi:chat-outline', label: '聊天',
      onClick: () => runDockAction('打开聊天窗口', () => tauriBridge.openChatWindow()) },
    { id: 'settings', icon: 'i-mdi:cog-outline',  label: '设置',
      onClick: () => runDockAction('打开设置窗口', () => tauriBridge.openSettingsWindow()) },
    {
      id: 'pin',
      icon: pinned ? 'i-mdi:pin' : 'i-mdi:pin-off-outline',
      label: pinned ? '取消置顶' : '置顶',
      toggled: pinned,
      disabled: pinUpdating,
      onClick: () => runDockAction('切换置顶状态', async () => {
        const next = !pinned;
        setPinUpdating(true);
        try {
          await tauriBridge.setAlwaysOnTop(next);
          setPinned(next);
        } finally {
          setPinUpdating(false);
        }
      }),
    },
    { id: 'quit', icon: 'i-mdi:power', label: '退出', danger: true,
      onClick: () => runDockAction('退出应用', () => tauriBridge.quit()) },
  ];

  return (
    <div
      data-tauri-drag-region="false"
      className={`absolute right-3 bottom-3 z-10 flex flex-col items-end gap-3 transition-opacity duration-[var(--ema-duration-base)] ${
        show ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
    >
      {/* ── More (click-to-toggle, flyout expands upward like a drawer) ── */}
      <div className="relative">
        <div
          className={`absolute bottom-full right-0 mb-3 p-3 rounded-2xl border shadow-[var(--ema-shadow-3)] backdrop-blur grid grid-cols-[repeat(3,auto)] gap-3 origin-bottom-right transition-ema ${
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
                disabled={btn.disabled}
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
      <Popover
        side="left"
        align="end"
        widthClass="w-56"
        trigger={(
          <IconButton
            size="lg"
            label="切换表情"
            icon="i-mdi:emoticon-happy-outline"
            disabled={!expressionAvailable}
            toggled={selectedExpression !== null}
            className="rounded-full shadow-[var(--ema-shadow-1)] backdrop-blur"
          />
        )}
      >
        <ScrollArea className="max-h-72">
          <div className="flex flex-col gap-1">
            <ExpressionChoice
              label="默认表情"
              selected={selectedExpression === null}
              onClick={() => onSelectExpression(null)}
            />
            {expressions.map(expression => (
              <ExpressionChoice
                key={expression}
                label={expression}
                selected={selectedExpression === expression}
                onClick={() => onSelectExpression(expression)}
              />
            ))}
          </div>
        </ScrollArea>
      </Popover>

      {/* ── Drag handle ── */}
      <Tooltip content="按住拖动" side="left">
        <IconButton
          size="lg"
          label="按住拖动"
          icon="i-mdi:drag"
          className="rounded-full shadow-[var(--ema-shadow-1)] backdrop-blur cursor-grab active:cursor-grabbing"
          onMouseDown={() => runDockAction('拖动窗口', () => tauriBridge.startDragging())}
        />
      </Tooltip>
    </div>
  );
}

interface ExpressionChoiceProps {
  label: string;
  selected: boolean;
  onClick(): void;
}

function ExpressionChoice({
  label,
  selected,
  onClick,
}: ExpressionChoiceProps): JSX.Element {
  return (
    <button
      type="button"
      className={`rounded-md px-2 py-1.5 text-left text-xs transition-colors ${selected
        ? 'bg-[var(--ema-primary-soft)] text-[var(--ema-primary)]'
        : 'text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-2)]'}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
