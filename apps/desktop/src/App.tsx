// 组装桌宠主窗口、Live2D 舞台、权限提示与桌面交互入口。
import { useCallback, useEffect, useRef, useState } from 'react';
import { CharacterStage }       from './components/CharacterStage.js';
import { SpeechBubble }          from './components/SpeechBubble.js';
import { PermissionToastLayer }  from './components/PermissionToastLayer.js';
import {
  defaultLive2DRuntime,
  type Live2DRuntime,
} from '@ema-agent/live2d-react';
import {
  FloatingDock, ShellSetupDialog, cardsApi, mountSystemEvents, shellApi, turnsApi, useCardStore, useSidecarStore, useRuntimeSettingsSync, useThemeSync, } from '@ema-agent/desktop-ui';
import type {
  CharacterStageSnapshot,
  ShellStatus,
  SidecarStatus,
} from '@ema-agent/desktop-ui';
import type { CharacterCardId, TurnId } from '@ema-agent/ids';
import {
  CharacterStageSnapshotLoader,
} from './characterStageSnapshotLoader.js';
import { useWindowSuspension } from './hooks/use-window-suspension.js';

// ── 主窗口 ──────────────────────────────────────────────────────────────────
//
// 透明窗口上的绝对定位层：
//   - DragLayer：覆盖全窗的透明拖拽区
//   - GlowBorder：窗口边缘呼吸光
//   - CharacterStage：Live2D、立绘或占位
//   - FloatingDock：鼠标进入窗口后出现的右侧工具条
//   - SidecarBadge：左上角 LocalHost 状态点
//
// Dock 监听 body 的鼠标进入和离开；离开后保留 600ms，避免沿右缘移动时闪烁。

const DOCK_FADE_GRACE_MS = 600;

export function App(): React.JSX.Element {
  const stageSuspended = useWindowSuspension();
  const sidecarStatus = useSidecarStore((s) => s.status);
  const activeCardId = useCardStore((s) => s.activeCardId);
  const activePresentationRevision = useCardStore((s) => {
    const card = s.cards.find((item) => item.id === s.activeCardId);
    if (!card) return '';
    return [
      card.updatedAt,
      ...[...card.live2dVariants, ...card.portraits]
        .map((resource) => [
          resource.id,
          resource.updatedAt,
          Number(resource.isPrimary),
          Number(resource.enabled),
        ].join(':'))
        .sort(),
    ].join('|');
  });
  const activeStageRuntime = useRef<Live2DRuntime | null>(null);
  const [stageRuntimeAvailable, setStageRuntimeAvailable] = useState(false);
  const [dockVisible,  setDockVisible]  = useState(false);
  const [shellStatus,  setShellStatus]  = useState<ShellStatus | null>(null);
  const [stageSnapshot, setStageSnapshot] = useState<CharacterStageSnapshot | null>(null);
  const [stageLoader] = useState(() => new CharacterStageSnapshotLoader({
    getPresentation: (cardId) => cardsApi.getPresentation(cardId),
  }));
  const handleStageRuntimeChanged = useCallback((runtime: Live2DRuntime | null): void => {
    activeStageRuntime.current = runtime;
    setStageRuntimeAvailable(runtime !== null);
  }, []);

  // LocalHost 首次可用及角色切换事件都会刷新 card-store；舞台只订阅稳定角色字段。
  useEffect(() => {
    if (sidecarStatus.kind !== 'ok') return;
    void useCardStore.getState().load();
  }, [sidecarStatus.kind]);

  // 同角色刷新保留旧快照到新候选就绪；跨角色先撤下旧角色，避免视觉与 Prompt 身份错位。
  useEffect(() => {
    stageLoader.invalidate();

    if (!activeCardId) {
      setStageSnapshot(null);
      return;
    }

    let disposed = false;
    setStageSnapshot((current) => (
      current?.characterId === activeCardId ? current : null
    ));
    void stageLoader.load(activeCardId)
      .then((snapshot) => {
        if (!disposed && snapshot) setStageSnapshot(snapshot);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        console.error('[stage] failed to load active character', activeCardId, error);
      });

    return () => {
      disposed = true;
      stageLoader.invalidate();
    };
  }, [activeCardId, activePresentationRevision, stageLoader]);

  useDevTtsPlaybackFromUrl(activeStageRuntime);
  useThemeSync();
  useRuntimeSettingsSync(sidecarStatus.kind === 'ok');

  // 主桌宠窗口与应用同生命周期，负责唯一的全局系统事件连接。
  useEffect(() => mountSystemEvents({ ownsConnection: true }), []);

  // LocalHost 可用后检查一次 Shell；非 Windows 平台会直接返回可用。
  useEffect(() => {
    if (sidecarStatus.kind !== 'ok') return;
    shellApi.status().then(setShellStatus).catch(() => { /* sidecar not yet settled */ });
  }, [sidecarStatus.kind]);

  // 主窗口持有 LocalHost 健康轮询。
  useEffect(() => {
    const stop = useSidecarStore.getState().startPolling();
    return stop;
  }, []);

  // 鼠标进出窗口时控制 Dock 显隐。
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

      {/* 拖拽层位于所有内容下方；可交互组件必须显式关闭 Tauri 拖拽。 */}
      <div style={dragLayerStyle} data-tauri-drag-region />

      <GlowBorder />

      <CharacterStage
        targetCharacterId={activeCardId}
        snapshot={stageSnapshot}
        suspended={stageSuspended}
        onRuntimeChanged={handleStageRuntimeChanged}
      />

      <SpeechBubble />

      <FloatingDock
        visible={dockVisible}
        expressionAvailable={stageRuntimeAvailable}
      />

      <SidecarBadge status={sidecarStatus} />

      {/* 主窗口只显示非阻塞授权提示；其他 AskUser 由聊天窗口的 Session 队列处理。 */}
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

function useDevTtsPlaybackFromUrl(runtime: React.RefObject<Live2DRuntime | null>): void {
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
        await testTtsPlayback(await response.arrayBuffer(), runtime.current);
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

// ── 粉白呼吸光边框 ──────────────────────────────────────────────────────────
//
// 视觉全部归 styles 的 .ema-pet-glow-border(含 ema-breathe keyframes 与签名粉 token)。

function GlowBorder(): React.JSX.Element {
  return <div className="ema-pet-glow-border" />;
}

const dragLayerStyle: React.CSSProperties = {
  position:      'fixed',
  inset:         0,
  zIndex:        0,
  // 拖拽区必须接收鼠标事件，因此不能设置 pointer-events:none。
};

// ── LocalHost 状态点 ─────────────────────────────────────────────────────────

function SidecarBadge({ status }: { status: SidecarStatus }): React.JSX.Element {
  const [hover, setHover] = useState(false);

  const dotColor = status.kind === 'ok'      ? 'var(--ema-success)'
                 : status.kind === 'pending' ? 'var(--ema-warning)'
                 : status.kind === 'error'   ? 'var(--ema-danger)'
                 :                              'var(--ema-text-tertiary)';

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
  background:     'var(--ema-surface-0)',
  border:         '1px solid var(--ema-glow)',
  borderRadius:   6,
  pointerEvents:  'none',
};

// ── 开发测试入口：让音频经过 Live2D 口型管线 ─────────────────────────────────

let _testAudioCtx: AudioContext | null = null;
let _testAnalyser: AnalyserNode | null = null;

async function testTtsPlayback(
  arrayBuffer: ArrayBuffer,
  runtime: Live2DRuntime | null = defaultLive2DRuntime,
): Promise<void> {
  const targetRuntime = runtime ?? defaultLive2DRuntime;
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
    targetRuntime.speechStore.getState().setRms(Math.sqrt(sum / rmsData.length));
    raf = requestAnimationFrame(loop);
  };

  targetRuntime.speechStore.getState().setSpeaking(true);
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
    targetRuntime.speechStore.getState().reset();
  }
}

if (import.meta.env.DEV) {
  (window as any).__testTtsPlayback = testTtsPlayback;
}
