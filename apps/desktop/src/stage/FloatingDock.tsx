// 提供桌宠主窗口的聊天, 设置, 置顶, 点击穿透, 表情, 拖动与退出入口.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { IconButton, Popover, ScrollArea, Tooltip } from '@ema-agent/ui';
import { tauriBridge } from '../lib/tauri-bridge.js';
import { showToast } from '../lib/toast.js';
import type { WallpaperSettings } from '@ema-agent/server/settings/wallpaperSetting.js';
import { DEFAULT_WALLPAPER_SETTINGS, WALLPAPER_SETTING_KEYS } from '@ema-agent/server/settings/wallpaperCatalog.js';
import { settingsApi } from '../api/settings.js';
import { subscribeSystemEvent } from '../lib/system-event-dispatcher.js';

export interface FloatingDockProps {
  suspended: boolean;
  expressionAvailable: boolean;
  expressions: readonly string[];
  selectedExpression: string | null;
  onSelectExpression(expression: string | null): void;
}

export function FloatingDock({
  suspended,
  expressionAvailable,
  expressions,
  selectedExpression,
  onSelectExpression,
}: FloatingDockProps): JSX.Element {
  const [wallpaper, setWallpaper] = useState<Pick<WallpaperSettings, 'enabled' | 'materialMode'>>({
    enabled: DEFAULT_WALLPAPER_SETTINGS.enabled,
    materialMode: DEFAULT_WALLPAPER_SETTINGS.materialMode,
  });
  const materialClass = wallpaper.enabled ? `ema-stage-${wallpaper.materialMode}` : '';

  useEffect(() => {
    let disposed = false;
    let sequence = 0;

    async function refresh(): Promise<void> {
      const requestSequence = ++sequence;
      try {
        const response = await settingsApi.getValue(WALLPAPER_SETTING_KEYS.settings);
        if (disposed || requestSequence !== sequence) return;
        const value = response.value as WallpaperSettings;
        setWallpaper({ enabled: value.enabled, materialMode: value.materialMode });
      } catch (error) {
        console.warn('[floating-dock] 读取浮层外观设置失败:', error);
      }
    }

    const stop = subscribeSystemEvent((event) => {
      if (event.type === 'settings_changed') void refresh();
    });
    void refresh();
    return () => {
      disposed = true;
      stop();
    };
  }, []);
  const [pinned,     setPinned]     = useState(true);
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const [pinUpdating, setPinUpdating] = useState(false);
  const [passthroughUpdating, setPassthroughUpdating] = useState(false);
  const [visible, setVisible] = useState(false);
  const [passthroughEnabled, setPassthroughEnabled] = useState(false);
  const [passthroughAvailable, setPassthroughAvailable] = useState(false);
  const suspendedRef = useRef(suspended);
  const pointerInsideRef = useRef(false);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  suspendedRef.current = suspended;

  const updatePointerPresence = useCallback((inside: boolean): void => {
    if (pointerInsideRef.current === inside) return;
    pointerInsideRef.current = inside;
    document.body.dataset.petPointerInside = String(inside);
    if (leaveTimerRef.current !== null) clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = null;
    if (inside) {
      setVisible(true);
    } else {
      leaveTimerRef.current = setTimeout(() => {
        setVisible(false);
        leaveTimerRef.current = null;
      }, 600);
    }
  }, []);

  useEffect(() => {
    if (!tauriBridge.isTauri()) {
      const enter = (): void => updatePointerPresence(true);
      const leave = (): void => updatePointerPresence(false);
      document.body.addEventListener('mouseenter', enter);
      document.body.addEventListener('mouseleave', leave);
      return () => {
        document.body.removeEventListener('mouseenter', enter);
        document.body.removeEventListener('mouseleave', leave);
      };
    }

    let disposed = false;
    let modeEventReceived = false;
    let enabled = false;
    let failed = false;
    let controlsHovered: boolean | null = null;
    let unlistenMode: (() => void) | null = null;
    let unlistenPointer: (() => void) | null = null;
    const acceptMode = (value: boolean): void => {
      enabled = value;
      controlsHovered = null;
      setPassthroughEnabled(value);
    };
    const failInteraction = (error: unknown): void => {
      if (disposed || failed) return;
      failed = true;
      setPassthroughAvailable(false);
      const message = error instanceof Error ? error.message : String(error);
      console.error('[floating-dock] 系统鼠标交互失败', error);
      if (enabled) {
        void tauriBridge.setPassthrough(false).catch((restoreError: unknown) => {
          console.error('[floating-dock] 关闭穿透失败', restoreError);
        });
      }
      showToast(`系统鼠标交互失败: ${message}. 若桌宠不可点击, 请从托盘关闭点击穿透`, {
        variant: 'danger', duration: 6000,
      });
    };

    void (async () => {
      unlistenMode = await tauriBridge.listenPassthrough((value) => {
        if (disposed) return;
        modeEventReceived = true;
        acceptMode(value);
      });
      if (disposed) {
        unlistenMode();
        return;
      }
      unlistenPointer = await tauriBridge.listenPetPointer((event) => {
        if (disposed) return;
        if (event.type === 'error') {
          failInteraction(event.message);
          return;
        }
        if (suspendedRef.current) return;
        updatePointerPresence(event.inside);
        if (!enabled || failed) return;
        const hovered = event.inside && isPetControlAt(event.clientX, event.clientY);
        if (hovered === controlsHovered) return;
        controlsHovered = hovered;
        void tauriBridge.setPassthroughControlsHovered(hovered).catch(failInteraction);
      });
      if (disposed) {
        unlistenPointer();
        return;
      }
      await tauriBridge.startPetPointer();
      const initialMode = await tauriBridge.getPassthrough();
      if (disposed) return;
      // 查询只补初值, 不能覆盖查询期间托盘或按钮发来的新模式.
      if (!modeEventReceived) acceptMode(initialMode);
      setPassthroughAvailable(!failed);
    })().catch(failInteraction);

    return () => {
      disposed = true;
      unlistenMode?.();
      unlistenPointer?.();
    };
  }, [updatePointerPresence]);

  useEffect(() => {
    if (suspended) updatePointerPresence(false);
  }, [suspended, updatePointerPresence]);

  useEffect(() => () => {
    if (leaveTimerRef.current !== null) clearTimeout(leaveTimerRef.current);
    delete document.body.dataset.petPointerInside;
  }, []);

  const show = visible && !suspended;
  let passthroughLabel = '点击穿透接口未就绪，请重启 Tauri 宿主';
  if (passthroughAvailable) {
    passthroughLabel = passthroughEnabled ? '关闭点击穿透' : '开启点击穿透';
  }

  const runDockAction = (label: string, action: () => Promise<void>): void => {
    void action().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[floating-dock] ${label} failed`, error);
      showToast(`${label}失败：${detail}`, { variant: 'danger', duration: 6000 });
    });
  };

  // 第一排聊天 / 设置 / 置顶, 第二排点击穿透 / 退出. 控制区与托盘都可关闭穿透.
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
    {
      id: 'passthrough',
      icon: 'i-mdi:ghost-outline',
      label: passthroughLabel,
      toggled: passthroughEnabled,
      disabled: passthroughUpdating || !passthroughAvailable,
      onClick: () => runDockAction('切换点击穿透', async () => {
        setPassthroughUpdating(true);
        try {
          await tauriBridge.setPassthrough(!passthroughEnabled);
          setFlyoutOpen(false);
        } finally {
          setPassthroughUpdating(false);
        }
      }),
    },
    { id: 'quit', icon: 'i-mdi:power', label: '退出', danger: true,
      onClick: () => runDockAction('退出应用', () => tauriBridge.quit()) },
  ];

  return (
    <div
      data-tauri-drag-region="false"
      data-pet-interactive={show ? '' : undefined}
      className={`absolute right-3 bottom-3 z-10 flex flex-col items-end gap-3 transition-opacity duration-[var(--ema-duration-base)] ${
        show ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
    >
      {/* ── More (click-to-toggle, flyout expands upward like a drawer) ── */}
      <div className="relative">
        <div
          data-pet-interactive={show && flyoutOpen ? '' : undefined}
          className={`ema-stage-surface ema-stage-dock-menu ${materialClass} absolute bottom-full right-0 mb-3 p-3 rounded-2xl border shadow-[var(--ema-shadow-3)] grid grid-cols-[repeat(3,auto)] gap-3 origin-bottom-right transition-ema ${
            flyoutOpen
              ? 'opacity-100 translate-y-0 scale-100'
              : 'opacity-0 translate-y-3 scale-90 pointer-events-none'
          }`}
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
        className={`ema-pet-interactive ema-stage-surface ${materialClass}`}
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

// 穿透时保护菜单, 权限提示和通知按钮. 8px 余量连接菜单之间的小间隙.
function isPetControlAt(clientX: number, clientY: number): boolean {
  const controls = document.querySelectorAll<HTMLElement>(
    '[data-pet-interactive], .ema-pet-interactive, [data-toast-id]',
  );
  for (const control of controls) {
    const style = getComputedStyle(control);
    if (style.pointerEvents === 'none' || style.visibility !== 'visible' || style.opacity === '0') continue;
    if (control.dataset.state === 'closed') continue;
    const rect = control.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (clientX >= rect.left - 8 && clientX <= rect.right + 8
      && clientY >= rect.top - 8 && clientY <= rect.bottom + 8) return true;
  }
  return false;
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
        ? 'bg-[var(--ema-primary-muted)] text-[var(--ema-primary)]'
        : 'text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-2)]'}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
