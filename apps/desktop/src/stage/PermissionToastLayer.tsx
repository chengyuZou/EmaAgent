// 在桌宠窗口显示不阻塞其他 Session 的精简 Permission 决策卡。
//
// 监听聊天窗口经 Tauri 中继的跨窗事件：
//   decision:push    — 原始 permission_required / ask_user_required 事件 → 弹出精简卡
//   decision:dismiss — 交互已决（toolCallId 锚）→ 卡片退场
//
// 只有 Permission 在桌宠窗口显示非阻塞 Toast；AskUser 是成批问答，桌宠窗口没有
// viewedSessionId 无法渲染阻塞式卡片，由聊天窗口的 DecisionLayer 处理。
//
// 多个 Session 可以同时堆叠卡片. 按钮经 Session WebSocket 回答队首,
// 不改变当前 TTS/Live2D 归属 Session。
import { useEffect, useState } from 'react';
import { Button } from '@ema-agent/ui';
import { tauriBridge } from '../lib/tauri-bridge.js';
import { SessionRequestError, sessionWebSocket } from '../api/sessionWebSocket.js';
import type { PermissionRequiredEvent, PermissionResponse } from '@ema-agent/permission';
import type { AskUserRequiredEvent } from '@ema-agent/tools';
import type { WallpaperSettings } from '@ema-agent/server/settings/wallpaperSetting.js';
import { DEFAULT_WALLPAPER_SETTINGS, WALLPAPER_SETTING_KEYS } from '@ema-agent/server/settings/wallpaperCatalog.js';
import { settingsApi } from '../api/settings.js';
import { subscribeSystemEvent } from '../lib/system-event-dispatcher.js';

/** decision:push 的载荷来自 Session 交互出口, 不依赖父 Turn 存活. */
type DecisionPushEvent = PermissionRequiredEvent | AskUserRequiredEvent;

// ── 根组件 ───────────────────────────────────────────────────────────────────

export function PermissionToastLayer(): React.JSX.Element {
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
        console.warn('[permission-toast] 读取浮层外观设置失败:', error);
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

  // AskUser 虽不在桌宠展示, 仍占这个 Session 的队首, 不能放行后面的批准.
  const [toasts, setToasts] = useState<DecisionPushEvent[]>([]);

  useEffect(() => {
    const unlistenPush = tauriBridge.listenDecisionRequired((p: DecisionPushEvent) => {
      // AskUser 只在聊天窗口处理；桌宠窗口不显示阻塞式问答。
      setToasts((prev) => {
        if (prev.some((t) => t.toolCallId === p.toolCallId)) {
          return prev;
        }
        return [...prev, p];
      });
    });

    const unlistenDismiss = tauriBridge.listenDecisionDismissed((toolCallId) => {
      setToasts((prev) => prev.filter((t) => t.toolCallId !== toolCallId));
    });

    return () => {
      void unlistenPush.then((fn) => fn());
      void unlistenDismiss.then((fn) => fn());
    };
  }, []);

  if (toasts.length === 0) {
    return <></>;
  }

  const removeToast = (toolCallId: string): void =>
    setToasts((prev) => prev.filter((t) => t.toolCallId !== toolCallId));

  return (
    <div
      data-tauri-drag-region={false}
      className={`ema-stage-permission-layer ${materialClass}`}
    >
      {toasts.filter((toast, index) => toast.type === 'permission_required'
        && !toasts.slice(0, index).some(previous => previous.sessionId === toast.sessionId))
        .map((toast) => toast.type === 'permission_required'
          && (
            <div
              key={toast.toolCallId}
              data-pet-interactive
              className="ema-stage-permission-entry"
            >
              <PermissionCard toast={toast} onDismiss={removeToast} />
            </div>
          ))}
    </div>
  );
}

// ── 单张权限卡 ────────────────────────────────────────────────────────────────

function PermissionCard({ toast, onDismiss }: {
  toast: PermissionRequiredEvent;
  onDismiss(toolCallId: string): void;
}): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const respond = async (response: PermissionResponse): Promise<void> => {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await sessionWebSocket.respondPermission(toast.sessionId, toast.toolCallId, response);
      onDismiss(toast.toolCallId);
    } catch (cause: unknown) {
      if (cause instanceof SessionRequestError && cause.code === 'not_found_or_expired') {
        onDismiss(toast.toolCallId);
        return;
      }
      setError(cause instanceof Error ? cause.message : '提交失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const desc = toast.toolDescription ?? `即将运行 ${toast.toolName}`;

  return (
    <ToastCard
      sessionId={toast.sessionId}
      label={toast.subagentId ? `子代理 · ${toast.subagentId.slice(0, 8)}` : '主 Agent'}
    >
      <p className="ema-stage-permission-tool">{toast.toolName}</p>
      <p className="ema-stage-permission-description">{desc}</p>
      <div className="ema-stage-permission-actions">
        <Button
          variant="danger"
          size="sm"
          disabled={submitting}
          onClick={() => void respond({ action: 'deny' })}
        >拒绝</Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={submitting}
          onClick={() => void respond({ action: 'allowSession' })}
        >此会话</Button>
        <Button
          variant="primary"
          size="sm"
          disabled={submitting}
          onClick={() => void respond({ action: 'allow' })}
        >允许</Button>
      </div>
      {error && <p className="ema-stage-permission-error">{error}</p>}
    </ToastCard>
  );
}

// ── 卡片外壳 ──────────────────────────────────────────────────────────────────

function ToastCard({ sessionId, label, children }: { sessionId?: string; label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="ema-stage-surface ema-stage-permission-card ema-toast-in">
      <div className="ema-stage-permission-header">
        <span className="ema-stage-permission-session">{sessionId?.slice(0, 8) ?? '—'}</span>
        <span className="ema-stage-permission-label">{label}</span>
      </div>
      {children}
    </div>
  );
}
