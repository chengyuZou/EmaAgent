// 组装桌宠主窗口、Live2D 舞台、权限提示与桌面交互入口。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CharacterStage,
  type ActiveLive2DStage,
} from './components/CharacterStage.js';
import { SpeechBubble }          from './components/SpeechBubble.js';
import { PermissionToastLayer }  from './components/PermissionToastLayer.js';
import { FloatingDock }           from './floating-dock/FloatingDock.js';
import { mountSystemEvents }      from './lib/system-sse.js';
import { turnsApi }               from './api/turns.js';
import { useCharacterStore }     from './stores/character-store.js';
import { useServerStore }         from './stores/server-store.js';
import { useRuntimeSettingsSync } from './stores/runtime-settings-sync.js';
import { useThemeSync }           from './stores/theme-store.js';
import type { ServerStatus }           from './stores/server-store.js';

import {
  CharacterStageLoader,
  loadCharacterStageView,
  type CharacterStageView,
} from './characterStageLoader.js';
import { useWindowSuspension } from './hooks/use-window-suspension.js';

// ── 主窗口 ──────────────────────────────────────────────────────────────────
//
// 透明窗口上的绝对定位层：
//   - DragLayer：覆盖全窗的透明拖拽区
//   - GlowBorder：窗口边缘呼吸光
//   - CharacterStage：Live2D、立绘或占位
//   - FloatingDock：鼠标进入窗口后出现的右侧工具条
//   - ServerBadge：左上角应用服务器状态点
//
// Dock 监听 body 的鼠标进入和离开；离开后保留 600ms，避免沿右缘移动时闪烁。

const DOCK_FADE_GRACE_MS = 600;

export function App(): React.JSX.Element {
  const stageSuspended = useWindowSuspension();
  const serverStatus = useServerStore((s) => s.status);
  const activeCharacterId = useCharacterStore((s) => s.activeCharacterId);
  const activePresentationRevision = useCharacterStore((s) => {
    const character = s.characters.find((item) => item.id === s.activeCharacterId);
    if (!character) return '';
    return [
      character.updatedAt,
      ...[...character.live2dModels, ...character.illustrations]
        .map((resource) => [
          resource.id,
          resource.updatedAt,
          Number(resource.isPrimary),
          Number(resource.enabled),
        ].join(':'))
        .sort(),
    ].join('|');
  });
  const activeStage = useRef<ActiveLive2DStage | null>(null);
  const [expressionAvailable, setExpressionAvailable] = useState(false);
  const [dockVisible,  setDockVisible]  = useState(false);
  const [stageView, setStageView] = useState<CharacterStageView | null>(null);
  const [stageLoader] = useState(() => new CharacterStageLoader({
    load: loadCharacterStageView,
  }));
  const handleStageChanged = useCallback((stage: ActiveLive2DStage | null): void => {
    activeStage.current = stage;
    setExpressionAvailable(stage?.hasExpressions ?? false);
  }, []);

  // 应用服务器首次可用及角色切换事件都会刷新 character-store；舞台只订阅稳定角色字段。
  useEffect(() => {
    if (serverStatus.kind !== 'ok') return;
    void useCharacterStore.getState().load();
  }, [serverStatus.kind]);

  // 同角色刷新保留旧快照到新候选就绪；跨角色先撤下旧角色，避免视觉与 Prompt 身份错位。
  useEffect(() => {
    stageLoader.invalidate();

    if (!activeCharacterId) {
      setStageView(null);
      return;
    }

    let disposed = false;
    setStageView((current) => (
      current?.characterId === activeCharacterId ? current : null
    ));
    void stageLoader.load(activeCharacterId)
      .then((view) => {
        if (!disposed && view) setStageView(view);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        console.error('[stage] failed to load active character', activeCharacterId, error);
      });

    return () => {
      disposed = true;
      stageLoader.invalidate();
    };
  }, [activeCharacterId, activePresentationRevision, stageLoader]);

  useDevTtsPlaybackFromUrl(activeStage);
  useThemeSync();
  useRuntimeSettingsSync(serverStatus.kind === 'ok');

  // 主桌宠窗口与应用同生命周期，负责唯一的全局系统事件连接。
  useEffect(() => mountSystemEvents({ ownsConnection: true }), []);

  // 主窗口持有应用服务器健康轮询。
  useEffect(() => {
    const stop = useServerStore.getState().startPolling();
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
        targetCharacterId={activeCharacterId}
        view={stageView}
        suspended={stageSuspended}
        onStageChanged={handleStageChanged}
      />

      <SpeechBubble />

      <FloatingDock
        visible={dockVisible}
        expressionAvailable={expressionAvailable}
      />

      <ServerBadge status={serverStatus} />

      {/* 主窗口只显示非阻塞授权提示；其他 AskUser 由聊天窗口的 Session 队列处理。 */}
      <PermissionToastLayer />
    </>
  );
}

function useDevTtsPlaybackFromUrl(stage: React.RefObject<ActiveLive2DStage | null>): void {
  useEffect(() => {
    if (!import.meta.env.DEV) return;

    const turnId = new URLSearchParams(window.location.search).get('ttsTestTurnId');
    if (!turnId) return;

    let disposed = false;
    const play = async (): Promise<void> => {
      if (disposed) return;
      window.removeEventListener('pointerdown', play);
      try {
        const url = await turnsApi.audioUrl(turnId);
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`audio fetch failed: ${response.status} ${response.statusText}`);
        }
        await testTtsPlayback(await response.arrayBuffer(), stage.current);
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

// ── 应用服务器状态点 ─────────────────────────────────────────────────────────

function ServerBadge({ status }: { status: ServerStatus }): React.JSX.Element {
  const [hover, setHover] = useState(false);

  const dotColor = status.kind === 'ok'      ? 'var(--ema-success)'
                 : status.kind === 'pending' ? 'var(--ema-warning)'
                 : status.kind === 'error'   ? 'var(--ema-danger)'
                 :                              'var(--ema-text-tertiary)';

  const detail = status.kind === 'ok'      ? `服务器 @ port ${status.port}`
               : status.kind === 'pending' ? '等待服务器启动 …'
               : status.kind === 'error'   ? `服务器错误：${status.reason}`
               :                              '服务器状态未知';

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
  stage: ActiveLive2DStage | null,
): Promise<void> {
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
    stage?.handle.setLipSync(true, Math.sqrt(sum / rmsData.length));
    raf = requestAnimationFrame(loop);
  };

  stage?.handle.setLipSync(true, 0);
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
    stage?.handle.setLipSync(false, 0);
  }
}

if (import.meta.env.DEV) {
  (window as any).__testTtsPlayback = testTtsPlayback;
}
