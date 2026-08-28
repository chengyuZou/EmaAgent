// 在桌宠窗口显示不阻塞其他 Session 的精简 Permission 决策卡。
//
// 监听聊天窗口经 Tauri 中继的跨窗事件：
//   decision:push    — 原始 permission_required / ask_user_required 事件 → 弹出精简卡
//   decision:dismiss — 交互已决（toolCallId 锚）→ 卡片退场
//
// 只有 Permission 在桌宠窗口显示非阻塞 Toast；AskUser 是成批问答，桌宠窗口没有
// viewedSessionId 无法渲染阻塞式卡片，由聊天窗口的 DecisionLayer 处理。
//
// 多个 Session 可以同时堆叠卡片。按钮直接 POST 后端应答通道，
// 不改变当前 TTS/Live2D 归属 Session。
import { useEffect, useState, type CSSProperties } from 'react';
import { Button } from '@ema-agent/ui';
import { tauriBridge } from '../lib/tauri-bridge.js';
import { ServerApiError } from '../api/client.js';
import { turnsApi } from '../api/turns.js';
import type { PermissionRequiredEvent, PermissionResponse } from '@ema-agent/permission';
import type { AskUserRequiredEvent } from '@ema-agent/tools';

/** decision:push 的载荷 = Turn 流原始决策事件。 */
type DecisionPushEvent = PermissionRequiredEvent | AskUserRequiredEvent;

// ── 根组件 ───────────────────────────────────────────────────────────────────

export function PermissionToastLayer(): React.JSX.Element {
  const [toasts, setToasts] = useState<PermissionRequiredEvent[]>([]);

  useEffect(() => {
    const unlistenPush = tauriBridge.listen<DecisionPushEvent>('decision:push', (e) => {
      const p = e.payload;
      // AskUser 只在聊天窗口处理；桌宠窗口不显示阻塞式问答。
      if (p.type !== 'permission_required') return;
      setToasts((prev) => {
        if (prev.some((t) => t.toolCallId === p.toolCallId)) return prev;
        return [...prev, p];
      });
    });

    const unlistenDismiss = tauriBridge.listen<{ toolCallId: string }>('decision:dismiss', (e) => {
      const { toolCallId } = e.payload;
      setToasts((prev) => prev.filter((t) => t.toolCallId !== toolCallId));
    });

    return () => {
      void unlistenPush.then((fn) => fn());
      void unlistenDismiss.then((fn) => fn());
    };
  }, []);

  if (toasts.length === 0) return <></>;

  const removeToast = (toolCallId: string): void =>
    setToasts((prev) => prev.filter((t) => t.toolCallId !== toolCallId));

  return (
    <div
      data-tauri-drag-region={false}
      style={{
        position:      'fixed',
        bottom:        90,          // 悬浮坞上方
        right:         10,
        zIndex:        200,
        display:       'flex',
        flexDirection: 'column-reverse',
        gap:           8,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((toast) => (
        <div key={toast.toolCallId} className="ema-toast-in" style={{ pointerEvents: 'auto' }}>
          <PermissionCard toast={toast} onDismiss={removeToast} />
        </div>
      ))}
    </div>
  );
}

// ── 单张权限卡 ────────────────────────────────────────────────────────────────

function PermissionCard({
  toast,
  onDismiss,
}: {
  toast: PermissionRequiredEvent;
  onDismiss(toolCallId: string): void;
}): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const respond = async (response: PermissionResponse): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await turnsApi.respondPermission(toast.turnId, toast.toolCallId, response);
      onDismiss(toast.toolCallId);
    } catch (cause: unknown) {
      if (cause instanceof ServerApiError && cause.status === 404) {
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
    <ToastCard sessionId={toast.sessionId} label="工具请求">
      <p style={toolNameStyle}>{toast.toolName}</p>
      <p style={descStyle}>{desc}</p>
      <div style={rowStyle}>
        <Button variant="danger" size="sm" disabled={submitting} onClick={() => void respond({ action: 'deny' })}>拒绝</Button>
        <Button variant="secondary" size="sm" disabled={submitting} onClick={() => void respond({ action: 'allowSession' })}>此会话</Button>
        <Button variant="primary" size="sm" disabled={submitting} onClick={() => void respond({ action: 'allow' })}>允许</Button>
      </div>
      {error && <p style={errorStyle}>{error}</p>}
    </ToastCard>
  );
}

// ── 卡片外壳 ──────────────────────────────────────────────────────────────────

function ToastCard({
  sessionId,
  label,
  children,
}: {
  sessionId?: string;
  label:      string;
  children:   React.ReactNode;
}): React.JSX.Element {
  return (
    <div style={cardStyle}>
      <div style={headerStyle}>
        <span style={sessionChipStyle}>{sessionId?.slice(0, 8) ?? '—'}</span>
        <span style={labelStyle}>{label}</span>
      </div>
      {children}
    </div>
  );
}

// ── 样式 ─────────────────────────────────────────────────────────────────────

const cardStyle: CSSProperties = {
  width:          234,
  background:     'var(--ema-surface-0)',
  border:         '1px solid var(--ema-glow)',
  borderRadius:   'var(--ema-radius-md)',
  padding:        '10px 12px',
  backdropFilter: 'var(--ema-glass-strong)',
  boxShadow:      'var(--ema-shadow-3)',
  display:        'flex',
  flexDirection:  'column',
  gap:            6,
};

const headerStyle: CSSProperties = {
  display:    'flex',
  alignItems: 'center',
  gap:        6,
};

const sessionChipStyle: CSSProperties = {
  fontSize:      10,
  fontFamily:    'monospace',
  padding:       '1px 6px',
  borderRadius:  'var(--ema-radius-pill)',
  background:    'var(--ema-primary-muted)',
  border:        '1px solid var(--ema-glow)',
  color:         'var(--ema-primary)',
  letterSpacing: '0.02em',
};

const labelStyle: CSSProperties = {
  fontSize: 10,
  color:    'var(--ema-text-tertiary)',
};

const toolNameStyle: CSSProperties = {
  margin:     0,
  fontSize:   12,
  fontWeight: 600,
  color:      'var(--ema-text-code)',
  fontFamily: 'monospace',
};

const descStyle: CSSProperties = {
  margin:              0,
  fontSize:            11.5,
  color:               'var(--ema-text-secondary)',
  lineHeight:          1.5,
  display:             '-webkit-box',
  WebkitLineClamp:     3,
  WebkitBoxOrient:     'vertical',
  overflow:            'hidden',
};

const errorStyle: CSSProperties = {
  margin:   0,
  fontSize: 10.5,
  color:    'var(--ema-danger-text)',
};

const rowStyle: CSSProperties = {
  display:        'flex',
  gap:            6,
  justifyContent: 'flex-end',
  marginTop:      2,
};
