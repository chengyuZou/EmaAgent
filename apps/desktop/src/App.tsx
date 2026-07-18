// 组装桌宠主窗口、Live2D 舞台、权限提示与桌面交互入口。
import { useEffect, useState } from 'react';
import { EmaStageView }          from './components/EmaStageView.js';
import { SpeechBubble }          from './components/SpeechBubble.js';
import { PermissionToastLayer }  from './components/PermissionToastLayer.js';
import { defaultLive2DRuntime, type Live2DModelRuntimeConfig } from '@ema-agent/live2d-react';
import { FloatingDock, ShellSetupDialog, shellApi, useSidecarStore, useThemeSync, cardsApi, turnsApi } from '@ema-agent/desktop-ui';
import type { ShellStatus, SidecarStatus } from '@ema-agent/desktop-ui';
import type { TurnId } from '@ema-agent/contracts';

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

const DOCK_FADE_GRACE_MS = 600;

export function App(): React.JSX.Element {
  const sidecarStatus = useSidecarStore((s) => s.status);
  const [dockVisible,  setDockVisible]  = useState(false);
  const [shellStatus,  setShellStatus]  = useState<ShellStatus | null>(null);
  const [modelPath,    setModelPath]    = useState<string | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<Live2DModelRuntimeConfig | null>(null);

  // Fetch the active card's Live2D model path + runtime config from the
  // sidecar. No hardcoding — the card's live2dModelId → live2d_models table
  // → storage_path tells us where the model lives.
  // model-path is REQUIRED (stage can't mount without it); runtime-config is
  // an OPTIONAL enhancement (emotion/motion map) whose 404 must NOT block
  // model loading — fetch them independently.
  useEffect(() => {
    if (sidecarStatus.kind !== 'ok') return;
    void (async () => {
      try {
        const cards = await cardsApi.list();
        const active = cards.find((c) => c.isActive);
        if (!active?.live2dModelId) return;
        const path = await cardsApi.getLive2dModelPath(active.id);
        setModelPath(path);
        try {
          const config = await cardsApi.getLive2dRuntimeConfig(active.id);
          setRuntimeConfig(config);
        } catch { /* runtime-config missing — model loads with defaults */ }
      } catch { /* sidecar not ready yet — will retry on next render */ }
    })();
  }, [sidecarStatus.kind]);

  useDevTtsPlaybackFromUrl();
  useThemeSync();

  // Shell availability check — runs once when the sidecar becomes reachable.
  // On non-Windows this always resolves to { available: true } immediately.
  useEffect(() => {
    if (sidecarStatus.kind !== 'ok') return;
    shellApi.status().then(setShellStatus).catch(() => { /* sidecar not yet settled */ });
  }, [sidecarStatus.kind]);

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
      {/* UnoCSS test — remove after confirming scanning works */}
      <div className="hidden flex-col absolute right-3 top-1/2 -translate-y-1/2 z-10 opacity-0 pointer-events-none rounded-full w-10 h-10 gap-2 backdrop-blur border" />

      {/*  Drag region — covers the whole window underneath everything else.
           Anything that should NOT drag (dock buttons, Live2D, future text
           inputs) sets `data-tauri-drag-region={false}` on itself.          */}
      <div style={dragLayerStyle} data-tauri-drag-region />

      <GlowBorder />

      {modelPath && (
        <EmaStageView
          modelPath={modelPath}
          runtimeConfig={runtimeConfig ?? undefined}
        />
      )}

      <SpeechBubble />

      <FloatingDock visible={dockVisible} />

      <SidecarBadge status={sidecarStatus} />

      {/* Non-blocking toasts for permission / ask_confirm. Other ask_* prompts
          are handled in the chat window's DecisionLayer (per-session queue);
          the pet window has no viewedSessionId so it never shows a modal. */}
      <PermissionToastLayer />

      {shellStatus?.available === false && (
        <ShellSetupDialog
          status={shellStatus}
          onResolved={() => shellApi.status(true).then(setShellStatus).catch(() => {})}
        />
      )}
    </>
  );
}

function useDevTtsPlaybackFromUrl(): void {
  useEffect(() => {
    if (!import.meta.env.DEV) return;

    const turnId = new URLSearchParams(window.location.search).get('ttsTestTurnId');
    if (!turnId) return;

    let disposed = false;
    const play = async (): Promise<void> => {
      if (disposed) return;
      window.removeEventListener('pointerdown', play);
      try {
        const url = await turnsApi.audioUrl(turnId as TurnId);
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`audio fetch failed: ${response.status} ${response.statusText}`);
        }
        await testTtsPlayback(await response.arrayBuffer());
      } catch (err) {
        console.error('[live2d-test] failed to play turn audio', err);
      }
    };

    console.info('[live2d-test] click the stage to play turn audio', turnId);
    window.addEventListener('pointerdown', play, { once: true });

    return () => {
      disposed = true;
      window.removeEventListener('pointerdown', play);
    };
  }, []);
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

function SidecarBadge({ status }: { status: SidecarStatus }): React.JSX.Element {
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

// ── Test harness: play audio through the Live2D lip-sync pipeline ─────────

let _testAudioCtx: AudioContext | null = null;
let _testAnalyser: AnalyserNode | null = null;

async function testTtsPlayback(arrayBuffer: ArrayBuffer): Promise<void> {
  if (!_testAudioCtx) {
    _testAudioCtx = new AudioContext();
    _testAnalyser = _testAudioCtx.createAnalyser();
    _testAnalyser.fftSize = 256;
    _testAnalyser.smoothingTimeConstant = 0.4;
    _testAnalyser.connect(_testAudioCtx.destination);
  }
  const ctx = _testAudioCtx!;
  const analyser = _testAnalyser!;

  let raf = 0;
  const rmsData = new Uint8Array(analyser.frequencyBinCount) as unknown as Uint8Array<ArrayBuffer>;
  const loop = (): void => {
    analyser.getByteTimeDomainData(rmsData);
    let sum = 0;
    for (let i = 0; i < rmsData.length; i++) {
      const v = (rmsData[i]! - 128) / 128;
      sum += v * v;
    }
    defaultLive2DRuntime.speechStore.getState().setRms(Math.sqrt(sum / rmsData.length));
    raf = requestAnimationFrame(loop);
  };

  defaultLive2DRuntime.speechStore.getState().setSpeaking(true);
  loop();

  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0) as ArrayBuffer);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(analyser);
    source.connect(ctx.destination);
    await new Promise<void>((r) => { source.onended = () => r(); source.start(); });
  } finally {
    cancelAnimationFrame(raf);
    defaultLive2DRuntime.speechStore.getState().reset();
  }
}

if (import.meta.env.DEV) {
  (window as any).__testTtsPlayback = testTtsPlayback;
}
