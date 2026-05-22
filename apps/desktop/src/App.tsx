import { useEffect, useRef, useState } from 'react';
import { Live2DStage }  from './components/Live2DStage.js';
import type { Live2DStageHandle } from './components/Live2DStage.js';
import { FloatingDock } from './components/FloatingDock.js';
import { getSidecarStatus } from './api/sidecar-status.js';
import type { SidecarStatus } from './api/sidecar-status.js';

// ── Main window ─────────────────────────────────────────────────────────────
//
// Layout:
//   - Live2DStage fills the entire transparent window
//   - FloatingDock pinned to right edge, vertically centered
//   - SidecarBadge in top-left, tiny dot + tooltip showing port/error
//
// The window itself is transparent + frameless (configured in tauri.conf.json),
// so the only visible pixels come from Live2D, the dock, and the badge.

const EMA_MODEL_PATH = '/live2d/ema/ema.model3.json';

export function App(): React.JSX.Element {
  const stageRef = useRef<Live2DStageHandle>(null);
  const [stageError, setStageError] = useState<string | null>(null);
  const [sidecar, setSidecar] = useState<SidecarStatus>({ kind: 'pending' });

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      if (cancelled) return;
      const next = await getSidecarStatus();
      if (cancelled) return;
      setSidecar(next);
      if (next.kind !== 'ok') setTimeout(() => { void tick(); }, 2_000);
    };
    void tick();
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <Live2DStage
        ref={stageRef}
        modelPath={EMA_MODEL_PATH}
        onError={(err) => setStageError(err.message)}
      />

      <FloatingDock />

      <SidecarBadge status={sidecar} />

      {stageError && (
        <div style={errorOverlayStyle}>Live2D 加载失败: {stageError}</div>
      )}
    </>
  );
}

// ── Sidecar status badge (small, unobtrusive) ───────────────────────────────

function SidecarBadge({ status }: { status: SidecarStatus }): React.JSX.Element {
  const [hover, setHover] = useState(false);

  const dotColor = status.kind === 'ok'      ? '#22c55e'
                 : status.kind === 'pending' ? '#f59e0b'
                 :                              '#ef4444';

  const detail = status.kind === 'ok'      ? `sidecar @ port ${status.port}`
               : status.kind === 'pending' ? '等待 sidecar 启动 …'
               :                              `sidecar 错误：${status.reason}`;

  return (
    <div
      style={badgeStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span style={{ ...dotStyle, background: dotColor }} />
      {hover && <span style={badgeTooltipStyle}>{detail}</span>}
    </div>
  );
}

const badgeStyle: React.CSSProperties = {
  position:       'fixed',
  top:            12,
  left:           12,
  width:          16,
  height:         16,
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'center',
  cursor:         'help',
  zIndex:         100,
};

const dotStyle: React.CSSProperties = {
  width:          10,
  height:         10,
  borderRadius:   '50%',
  boxShadow:      '0 0 6px rgba(0,0,0,0.4)',
};

const badgeTooltipStyle: React.CSSProperties = {
  position:       'absolute',
  top:            22,
  left:           0,
  whiteSpace:     'nowrap',
  fontSize:       12,
  padding:        '4px 8px',
  background:     'rgba(20, 22, 30, 0.95)',
  border:         '1px solid rgba(255,255,255,0.1)',
  borderRadius:   6,
  pointerEvents:  'none',
};

const errorOverlayStyle: React.CSSProperties = {
  position:       'fixed',
  bottom:         20,
  left:           20,
  right:          20,
  padding:        '8px 12px',
  background:     'rgba(220, 50, 50, 0.85)',
  borderRadius:   6,
  fontSize:       12,
  zIndex:         200,
};
