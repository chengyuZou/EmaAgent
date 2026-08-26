/**
 * 在桌宠窗口显示不阻塞其他 Session 的精简 Permission 决策卡。
 *
 * Listens to Tauri IPC events relayed from the chat window:
 *   decision:push    — new prompt → show compact toast card
 *   decision:dismiss — prompt resolved → animate card out
 *
 * 只有 permission 在桌宠窗口显示非阻塞 Toast；AskUser 是成批问答，桌宠窗口没有
 * viewedSessionId 无法渲染阻塞式卡片，由聊天窗口的 DecisionLayer 处理。
 *
 * Multiple sessions can have stacked prompts simultaneously. Clicking buttons
 * POSTs directly to the backend; does NOT change the active TTS/Live2D session.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { Button } from '@ema-agent/ui';
import { tauriBridge } from '../lib/tauri-bridge.js';
import { ServerApiError } from '../api/client.js';
import { turnsApi } from '../api/turns.js';
import type { PermissionResponse } from '@ema-agent/permission';

// ── Toast 协议类型 ───────────────────────────────────────────────────────────

/**
 * decision:push 通道载荷的本地 ViewModel：聊天窗口从 Turn 流 permission_required
 * 投影后转发，交互锚为 toolCallId（与后端应答通道一致）。
 */
interface PermissionToastPayload {
  kind: 'permission';
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  toolDescription?: string;
}

// ── Root ─────────────────────────────────────────────────────────────────────

export function PermissionToastLayer(): React.JSX.Element {
  const [toasts, setToasts] = useState<PermissionToastPayload[]>([]);

  useEffect(() => {
    const unlistenPush = tauriBridge.listen<PermissionToastPayload>('decision:push', (e) => {
      const p = e.payload;
      if (p.kind !== 'permission') return;
      // AskUser 只在聊天窗口处理；桌宠窗口不显示阻塞式问答。
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
        bottom:        90,          // above FloatingDock
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

// ── Permission card ───────────────────────────────────────────────────────────

function PermissionCard({
  toast,
  onDismiss,
}: {
  toast: PermissionToastPayload;
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

// ── Shared card shell ─────────────────────────────────────────────────────────

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

// ── Styles ────────────────────────────────────────────────────────────────────

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
