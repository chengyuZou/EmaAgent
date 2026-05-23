import { useEffect, useState } from 'react';
import { EmaStageView } from './components/EmaStageView.js';
import { FloatingDock } from '@ema-agent/desktop-ui';
import { DecisionLayer } from '@ema-agent/desktop-ui';
import { useSidecarStore } from '@ema-agent/desktop-ui';

// ── Main window ─────────────────────────────────────────────────────────────
//
// Layout (all positioned absolute over a transparent window):
//   - <DragLayer>             — invisible full-window drag region (Tauri)
//   - <GlowBorder>            — pink-white breathing ring around the window
//   - <Live2DStage>           — character (half-body framing in component)
//   - <FloatingDock>          — right edge, fades in on cursor-in-window
//   - <SidecarBadge>          — top-left dot, tooltip on hover
//
// Dock visibility: tracks DOM mouseenter / mouseleave on the body. On enter,
// dock fades in (opacity 0 → 1). On leave with a 600 ms grace, fades out.
// Grace keeps the dock visible while you move along its right edge briefly.

const EMA_MODEL_PATH = '/live2d/ema/ema.model3.json';
const DOCK_FADE_GRACE_MS = 600;

export function App(): React.JSX.Element {
  const sidecarStatus = useSidecarStore((s) => s.status);
  const [dockVisible, setDockVisible] = useState(false);

  // Sidecar health polling
  useEffect(() => {
    const stop = useSidecarStore.getState().startPolling();
    return stop;
  }, []);

  // Dock visibility tracking (cursor in / out of the window body)
  useEffect(() => {
    let leaveTimer: ReturnType<typeof setTimeout> | null = null;
    const onEnter = (): void => {
      if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
      setDockVisible(true);
    };
    const onLeave = (): void => {
      if (leaveTimer) clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => setDockVisible(false), DOCK_FADE_GRACE_MS);
    };
    document.body.addEventListener('mouseenter', onEnter);
    document.body.addEventListener('mouseleave', onLeave);
    return () => {
      document.body.removeEventListener('mouseenter', onEnter);
      document.body.removeEventListener('mouseleave', onLeave);
      if (leaveTimer) clearTimeout(leaveTimer);
    };
  }, []);

  return (
    <>
      {/*  Drag region — covers the whole window underneath everything else.
           Anything that should NOT drag (dock buttons, Live2D, future text
           inputs) sets `data-tauri-drag-region={false}` on itself.          */}
      <div style={dragLayerStyle} data-tauri-drag-region />

      <GlowBorder />

      <EmaStageView modelPath={EMA_MODEL_PATH} />

      <FloatingDock visible={dockVisible} />

      <SidecarBadge status={sidecarStatus} />

      <DecisionLayer />
    </>
  );
}

// ── Pink-white breathing glow border ────────────────────────────────────────
//
// Two layered box-shadows on an empty positioned div:
//   - inner ring     (subtle, always on)
//   - outer pulse    (animated opacity, slow breathing)
// pointer-events: none so it never blocks dock/drag.

function GlowBorder(): React.JSX.Element {
  return (
    <>
      <style>{`
        @keyframes ema-breathe {
          0%, 100% { opacity: 0.35; }
          50%      { opacity: 0.78; }
        }
      `}</style>
      <div style={glowStyle} />
    </>
  );
}

const PINK_WHITE        = 'rgba(255, 214, 230, 0.55)';
const PINK_WHITE_BRIGHT = 'rgba(255, 192, 214, 0.85)';

const glowStyle: React.CSSProperties = {
  position:      'fixed',
  inset:         0,
  borderRadius:  16,
  pointerEvents: 'none',
  zIndex:        1,
  // Inset glow lives on the border itself, outset glow softens outward
  boxShadow:     [
    `inset 0 0 12px 1px ${PINK_WHITE}`,
    `inset 0 0 28px 4px rgba(255, 214, 230, 0.18)`,
    `0 0 24px 2px ${PINK_WHITE_BRIGHT}`,
  ].join(', '),
  animation:     'ema-breathe 2.6s ease-in-out infinite',
};

const dragLayerStyle: React.CSSProperties = {
  position:      'fixed',
  inset:         0,
  zIndex:        0,
  // Drag region needs to be opaque to mouse events, so no pointer-events: none.
  // Stays underneath dock/stage which set their own zIndex.
};

// ── Sidecar status badge ────────────────────────────────────────────────────

function SidecarBadge({ status }: { status: import('@ema-agent/desktop-ui').SidecarStatus }): React.JSX.Element {
  const [hover, setHover] = useState(false);

  const dotColor = status.kind === 'ok'      ? '#22c55e'
                 : status.kind === 'pending' ? '#f59e0b'
                 : status.kind === 'error'   ? '#ef4444'
                 :                              '#6b7280';

  const detail = status.kind === 'ok'      ? `sidecar @ port ${status.port}`
               : status.kind === 'pending' ? '等待 sidecar 启动 …'
               : status.kind === 'error'   ? `sidecar 错误：${status.reason}`
               :                              'sidecar 状态未知';

  return (
    <div
      style={badgeStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      data-tauri-drag-region={false}
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
  border:         '1px solid rgba(255, 214, 230, 0.18)',
  borderRadius:   6,
  pointerEvents:  'none',
};
