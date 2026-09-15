// 组装桌宠主窗口、Live2D 舞台、权限提示与桌面交互入口。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CharacterStagePresentation } from '@ema-agent/characters';
import { Tooltip } from '@ema-agent/ui';
import './styles/index.css';
import {
  CharacterStage,
  type ActiveLive2DStage,
} from './stage/CharacterStage.js';
import { SpeechBubble } from './stage/SpeechBubble.js';
import { PermissionToastLayer } from './stage/PermissionToastLayer.js';
import { FloatingDock } from './stage/FloatingDock.js';
import { mountSystemEvents } from './lib/system-sse.js';
import { useCharacterStore } from './stores/character.js';
import { useServerStore } from './stores/server.js';
import { useSettingsSync } from './stores/settings-sync.js';
import { useThemeSync } from './stores/theme.js';
import type { ServerStatus } from './stores/server.js';
import { charactersApi } from './api/characters.js';
import { useWindowSuspension } from './hooks/use-window-suspension.js';
import { tauriBridge } from './lib/tauri-bridge.js';
import { subscribeSystemEvent } from './lib/system-event-dispatcher.js';

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
  const activeCharacterName = useCharacterStore((s) => s.activeName);
  const activeStage = useRef<ActiveLive2DStage | null>(null);
  const [expressionAvailable, setExpressionAvailable] = useState(false);
  const [expressions, setExpressions] = useState<readonly string[]>([]);
  const [selectedExpression, setSelectedExpression] = useState<string | null>(null);
  const [dockVisible, setDockVisible] = useState(false);
  const [stagePresentation, setStagePresentation] = useState<CharacterStagePresentation | null>(null);
  const [presentationChangeCount, setPresentationChangeCount] = useState(0);
  const stageRequestSequence = useRef(0);
  const handleStageChanged = useCallback((stage: ActiveLive2DStage | null): void => {
    activeStage.current = stage;
    setExpressionAvailable(stage?.hasExpressions ?? false);
    setExpressions(stage?.expressions ?? []);
    setSelectedExpression(null);
  }, []);

  // 应用服务器首次可用及角色切换事件都会刷新角色 store；舞台只订阅稳定角色字段。
  useEffect(() => {
    if (serverStatus.kind !== 'ok') return;
    void useCharacterStore.getState().load();
  }, [serverStatus.kind]);

  useEffect(() => subscribeSystemEvent((event) => {
    if (
      event.type === 'character_presentation_changed'
      && event.characterName === useCharacterStore.getState().activeName
    ) {
      setPresentationChangeCount(count => count + 1);
    }
  }), []);

  // 角色切换和真正影响主舞台的事件才重新读取 presentation。普通资源导入只刷新
  // Settings 列表,不能让正在渲染的主模型因为一张封面变化而重新加载。
  useEffect(() => {
    const requestSequence = ++stageRequestSequence.current;

    if (!activeCharacterName) {
      setStagePresentation(null);
      return;
    }

    setStagePresentation((current) => (
      current?.characterName === activeCharacterName ? current : null
    ));
    const presentationStartedAt = performance.now();
    void tauriBridge.reportLive2dDiagnostic(
      'presentation_loading',
      activeCharacterName,
      null,
    );
    void charactersApi.presentation(activeCharacterName)
      .then((presentation) => {
        if (requestSequence === stageRequestSequence.current) {
          void tauriBridge.reportLive2dDiagnostic(
            'presentation_loaded',
            activeCharacterName,
            presentation.status === 'live2d' ? presentation.resource.name : null,
            (performance.now() - presentationStartedAt) / 1000,
          );
          setStagePresentation(presentation);
        }
      })
      .catch((error: unknown) => {
        if (requestSequence === stageRequestSequence.current) {
          void tauriBridge.reportLive2dDiagnostic(
            'presentation_failed',
            activeCharacterName,
            null,
            (performance.now() - presentationStartedAt) / 1000,
            String(error),
          );
          console.error('[stage] 角色呈现读取失败', activeCharacterName, error);
        }
      });

    return () => {
      stageRequestSequence.current += 1;
    };
  }, [activeCharacterName, presentationChangeCount]);

  useThemeSync();
  useSettingsSync(serverStatus.kind === 'ok');

  // 主桌宠窗口与应用同生命周期，负责唯一的全局系统事件连接。
  useEffect(() => mountSystemEvents({ ownsConnection: true }), []);

  useEffect(() => {
    const unlistenPreview = tauriBridge.listenLive2dPreview((command) => {
      const stage = activeStage.current;
      if (!stage) {
        void tauriBridge.reportLive2dDiagnostic(
          'preview_ignored',
          useCharacterStore.getState().activeName,
          null,
        );
        return;
      }
      if (command.type === 'expression') {
        void tauriBridge.reportLive2dDiagnostic(
          'preview_expression',
          stage.characterName,
          stage.modelName,
        );
        stage.handle.setExpression(command.expression);
        setSelectedExpression(command.expression);
      } else if (command.type === 'motion') {
        void tauriBridge.reportLive2dDiagnostic(
          'preview_motion',
          stage.characterName,
          stage.modelName,
        );
        stage.handle.playMotion(command.group, command.index);
      } else {
        void tauriBridge.reportLive2dDiagnostic(
          'preview_placement',
          stage.characterName,
          stage.modelName,
        );
        stage.handle.setPlacement(
          command.stageScale,
          command.stageOffsetX,
          command.stageOffsetY,
        );
      }
    });
    return () => {
      void unlistenPreview.then(stop => stop());
    };
  }, []);

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
        targetCharacterName={activeCharacterName}
        presentation={stagePresentation}
        suspended={stageSuspended}
        onStageChanged={handleStageChanged}
        onExpressionChanged={setSelectedExpression}
      />

      <SpeechBubble />

      <FloatingDock
        visible={dockVisible}
        expressionAvailable={expressionAvailable}
        expressions={expressions}
        selectedExpression={selectedExpression}
        onSelectExpression={(expression) => {
          activeStage.current?.handle.setExpression(expression);
          setSelectedExpression(expression);
        }}
      />

      <ServerBadge status={serverStatus} />

      {/* 主窗口只显示非阻塞授权提示；其他 AskUser 由聊天窗口的 Session 队列处理。 */}
      <PermissionToastLayer />
    </>
  );
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
  const detail = status.kind === 'ok'      ? `服务器 @ port ${status.port}`
               : status.kind === 'pending' ? '等待服务器启动 …'
               : status.kind === 'error'   ? `服务器错误：${status.reason}`
               :                              '服务器状态未知';

  return (
    <Tooltip content={detail} side="right" sideOffset={8}>
      <button
        type="button"
        className="ema-server-status"
        data-status={status.kind}
        aria-label={detail}
      >
        <span className="ema-server-status-dot" />
      </button>
    </Tooltip>
  );
}

// ── 开发测试入口：让音频经过 Live2D 口型管线 ─────────────────────────────────
