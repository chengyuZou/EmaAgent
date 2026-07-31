/**
 * 在桌宠窗口显示不阻塞其他 Session 的精简 Permission 与 AskConfirm 决策卡。
 *
 * Listens to Tauri IPC events relayed from the chat window:
 *   decision:push    — new prompt → show compact toast card
 *   decision:dismiss — prompt resolved → animate card out
 *
 * Permission + ask_confirm → compact non-blocking toast cards (this layer).
 * ask_text / ask_choice / ask_user → NOT shown in the pet window. The pet
 * window has no viewedSessionId so it cannot render a blocking modal; these
 * prompts are handled in the chat window's DecisionLayer. The sidebar badge
 * there surfaces pending counts per session.
 *
 * Multiple sessions can have stacked prompts simultaneously. Clicking buttons
 * POSTs directly to the backend; does NOT change the active TTS/Live2D session.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { Button } from '@ema-agent/ui';
import {
  tauriBridge,
  permissionApi,
  SidecarApiError,
  turnsApi,
  type DecisionPrompt,
} from '@ema-agent/desktop-ui';

// ── Toast item types ──────────────────────────────────────────────────────────

type PermissionToast = Extract<DecisionPrompt, { kind: 'permission' }>;
type AskConfirmToast = Extract<DecisionPrompt, { kind: 'ask_confirm' }>;
type QuickToast      = PermissionToast | AskConfirmToast;

// ── Root ─────────────────────────────────────────────────────────────────────

export function PermissionToastLayer(): React.JSX.Element {
  const [toasts, setToasts] = useState<QuickToast[]>([]);

  useEffect(() => {
    const unlistenPush = tauriBridge.listen<DecisionPrompt>('decision:push', (e) => {
      const p = e.payload;
      if (p.kind === 'permission' || p.kind === 'ask_confirm') {
        setToasts((prev) => {
          if (prev.some((t) => t.promptId === p.promptId)) return prev;
          return [...prev, p as QuickToast];
        });
      }
      // ask_text / ask_choice / ask_user are handled in the chat window only.
    });

    const unlistenDismiss = tauriBridge.listen<{ promptId: string }>('decision:dismiss', (e) => {
      const { promptId } = e.payload;
      setToasts((prev) => prev.filter((t) => t.promptId !== promptId));
    });

    return () => {
      void unlistenPush.then((fn) => fn());
      void unlistenDismiss.then((fn) => fn());
    };
  }, []);

  if (toasts.length === 0) return <></>;

  const removeToast = (promptId: string): void =>
    setToasts((prev) => prev.filter((t) => t.promptId !== promptId));

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
        <div key={toast.promptId} className="ema-toast-in" style={{ pointerEvents: 'auto' }}>
          {toast.kind === 'permission'
            ? <PermissionCard toast={toast} onDismiss={removeToast} />
            : <AskConfirmCard toast={toast} onDismiss={removeToast} />}
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
  toast: PermissionToast;
  onDismiss(promptId: string): void;
}): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const respond = async (action: 'allow' | 'allow_session' | 'deny'): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await permissionApi.respond(toast.turnId, toast.promptId, { action });
      onDismiss(toast.promptId);
    } catch (cause: unknown) {
      if (cause instanceof SidecarApiError && cause.status === 404) {
        onDismiss(toast.promptId);
        return;
      }
      setError(cause instanceof Error ? cause.message : '提交失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const desc = toast.humanDescriptionPending
    ? toast.hint
    : (toast.humanDescription ?? toast.toolDescription ?? toast.hint);

  return (
    <ToastCard sessionId={toast.sessionId} label="工具请求">
      <p style={toolNameStyle}>{toast.toolName}</p>
      <p style={descStyle}>{desc}</p>
      <div style={rowStyle}>
        <Button variant="danger" size="sm" disabled={submitting} onClick={() => void respond('deny')}>拒绝</Button>
        <Button variant="secondary" size="sm" disabled={submitting} onClick={() => void respond('allow_session')}>此会话</Button>
        <Button variant="primary" size="sm" disabled={submitting} onClick={() => void respond('allow')}>允许</Button>
      </div>
      {error && <p style={errorStyle}>{error}</p>}
    </ToastCard>
  );
}

// ── Ask-confirm card ──────────────────────────────────────────────────────────

function AskConfirmCard({
  toast,
  onDismiss,
}: {
  toast: AskConfirmToast;
  onDismiss(promptId: string): void;
}): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const respond = async (confirmed: boolean): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await turnsApi.respondAskUser(toast.turnId, toast.promptId, { confirmed: String(confirmed) });
      onDismiss(toast.promptId);
    } catch (cause: unknown) {
      if (cause instanceof SidecarApiError && cause.status === 404) {
        onDismiss(toast.promptId);
        return;
      }
      setError(cause instanceof Error ? cause.message : '提交失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const body = toast.humanDescription ?? toast.question;
  const sub  = toast.humanDescription ? toast.question : undefined;

  return (
    <ToastCard sessionId={toast.sessionId} label="确认请求">
      <p style={descStyle}>{body}</p>
      {sub && <p style={subStyle}>{sub}</p>}
      <div style={rowStyle}>
        <Button variant="secondary" size="sm" disabled={submitting} onClick={() => void respond(false)}>否</Button>
        <Button variant="primary" size="sm" disabled={submitting} onClick={() => void respond(true)}>确认</Button>
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

const subStyle: CSSProperties = {
  margin:     0,
  fontSize:   11,
  color:      'var(--ema-text-tertiary)',
  lineHeight: 1.4,
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
