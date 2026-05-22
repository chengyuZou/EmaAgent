import { useEffect, useState } from 'react';
import { getSidecarStatus } from './api/sidecar-status.js';
import type { SidecarStatus } from './api/sidecar-status.js';

// ── Main window placeholder ─────────────────────────────────────────────────
//
// P1-1a verification surface: shows the sidecar's port + /api/health response.
// Once this renders "Sidecar: ok" we know:
//   1. Tauri spawned ema-core
//   2. The Vite frontend loaded inside Tauri's webview
//   3. fetch from frontend to sidecar localhost works through the webview
//
// Live2D + floating dock + multi-window comes in P1-1b/c.

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<SidecarStatus>({ kind: 'pending' });

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      if (cancelled) return;
      const next = await getSidecarStatus();
      if (!cancelled) setStatus(next);
      // Re-poll every 2s until we get an "ok" — covers slow sidecar startup
      if (!cancelled && next.kind !== 'ok') {
        setTimeout(() => { void tick(); }, 2_000);
      }
    };
    void tick();
    return () => { cancelled = true; };
  }, []);

  return (
    <div style={panelStyle}>
      <h1 style={titleStyle}>Ema · P1-1a</h1>
      <div style={lineStyle}><strong>sidecar:</strong> {renderStatus(status)}</div>
      <div style={hintStyle}>
        Live2D + 悬浮 dock + 子窗在 P1-1b / 1c 加。这屏只是验证 Tauri 壳 + sidecar 通了。
      </div>
    </div>
  );
}

function renderStatus(s: SidecarStatus): string {
  switch (s.kind) {
    case 'pending': return '等待 Tauri 拉起 ema-core …';
    case 'ok':      return `ok @ port ${s.port}`;
    case 'error':   return `error — ${s.reason}`;
  }
}

const panelStyle: React.CSSProperties = {
  position:         'fixed',
  top:              '50%',
  left:             '50%',
  transform:        'translate(-50%, -50%)',
  padding:          '24px 32px',
  background:       'rgba(20, 22, 30, 0.85)',
  border:           '1px solid rgba(255,255,255,0.1)',
  borderRadius:     12,
  minWidth:         320,
  boxShadow:        '0 8px 32px rgba(0,0,0,0.4)',
  backdropFilter:   'blur(8px)',
};

const titleStyle: React.CSSProperties = {
  fontSize:     14,
  margin:       '0 0 12px',
  opacity:      0.6,
  letterSpacing: '0.05em',
};

const lineStyle: React.CSSProperties = {
  fontSize:     16,
  marginBottom: 8,
};

const hintStyle: React.CSSProperties = {
  fontSize:    12,
  opacity:     0.5,
  marginTop:   16,
  lineHeight:  1.6,
};
