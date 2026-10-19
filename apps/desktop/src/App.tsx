import { useCallback, useEffect, useRef, useState } from 'react';
import type { CharacterStagePresentation } from '@ema-agent/characters';
import { Tooltip } from '@ema-agent/ui';
import {
  CharacterStage,
  StageFailure,
  StageLoading,
  type ActiveLive2DStage,
} from './stage/CharacterStage.js';
import { SpeechBubble } from './stage/SpeechBubble.js';
import { PermissionToastLayer } from './stage/PermissionToastLayer.js';
import { FloatingDock } from './stage/FloatingDock.js';
import { mountSystemEvents } from './lib/events/systemSse.js';
import { useCharacterStore } from './stores/character.js';
import { useServerStore } from './stores/server.js';
import { useSettingsSync } from './stores/settings-sync.js';
import { useThemeSync } from './stores/theme.js';
import type { ServerStatus } from './stores/server.js';
import { charactersApi } from './api/characters.js';
import { useWindowSuspension } from './hooks/use-window-suspension.js';
import { tauriBridge } from './lib/tauri/tauriBridge.js';
import { subscribeSystemEvent } from './lib/events/systemEventDispatcher.js';
import { resolveConfiguredEventNotification } from './lib/notifications/eventNotifications.js';
import { showToast } from './lib/notifications/toast.js';
import { handleCharacterSystemEvent } from './stores/character.js';
import { handleSettingsSystemEvent, useSettingsStore } from './stores/settings.js';

export function App(): React.JSX.Element {
  const stageControlsHidden = useWindowSuspension();
  const serverStatus = useServerStore((s) => s.status);
  const activeCharacterName = useCharacterStore((s) => s.activeName);
  const charactersLoading = useCharacterStore((s) => s.loading);
  const charactersError = useCharacterStore((s) => s.error);
  const [charactersLoaded, setCharactersLoaded] = useState(false);
  const activeStage = useRef<ActiveLive2DStage | null>(null);
  const [expressionAvailable, setExpressionAvailable] = useState(false);
  const [expressions, setExpressions] = useState<readonly string[]>([]);
  const [selectedExpression, setSelectedExpression] = useState<string | null>(null);
  const [stagePresentation, setStagePresentation] = useState<CharacterStagePresentation | null>(null);
  const [presentationError, setPresentationError] = useState<{
    characterName: string;
    message: string;
  } | null>(null);
  const [presentationChangeCount, setPresentationChangeCount] = useState(0);
  const stageRequestSequence = useRef(0);
  const handleStageChanged = useCallback((stage: ActiveLive2DStage | null): void => {
    activeStage.current = stage;
    setExpressionAvailable(stage?.hasExpressions ?? false);
    setExpressions(stage?.expressions ?? []);
    setSelectedExpression(null);
  }, []);

  // 首次读取结束前不能把空角色列表当成用户主动选择的空白舞台.
  useEffect(() => {
    if (serverStatus.kind !== 'ok') return;
    let cancelled = false;
    void useCharacterStore.getState().load().then(() => {
      if (!cancelled) setCharactersLoaded(true);
    });
    return () => { cancelled = true; };
  }, [serverStatus.kind]);

  useEffect(() => subscribeSystemEvent((event) => {
    handleCharacterSystemEvent(event);
    handleSettingsSystemEvent(event);

    // stage 持有 System SSE 并展示应用事件通知. main 接收广播更新共享状态, 不重复弹通知.
    const config = useSettingsStore.getState().eventDisplay?.[event.type];
    const notification = resolveConfiguredEventNotification(event, config);
    if (notification) {
      showToast(notification.message, {
        variant: notification.variant,
        duration: notification.duration,
        accentColor: notification.accentColor,
      });
    }

    if (
      event.type === 'character_presentation_changed'
      && event.characterName === useCharacterStore.getState().activeName
    ) {
      setPresentationChangeCount(count => count + 1);
    }
  }), []);

  // 角色切换和影响舞台的事件才重新读取 presentation.
  // 普通资源导入只刷新 Settings 列表, 不让当前模型因为封面变化而重新加载.
  useEffect(() => {
    const requestSequence = ++stageRequestSequence.current;
    setPresentationError(null);

    if (!activeCharacterName) {
      setStagePresentation(null);
      return;
    }

    setStagePresentation((current) => (
      current?.characterName === activeCharacterName ? current : null
    ));
    void charactersApi.presentation(activeCharacterName)
      .then((presentation) => {
        if (requestSequence === stageRequestSequence.current) {
          setStagePresentation(presentation);
        }
      })
      .catch((error: unknown) => {
        if (requestSequence === stageRequestSequence.current) {
          console.error('[stage] 角色呈现读取失败', activeCharacterName, error);
          setPresentationError({
            characterName: activeCharacterName,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      stageRequestSequence.current += 1;
    };
  }, [activeCharacterName, presentationChangeCount]);

  useThemeSync();
  useSettingsSync(serverStatus.kind === 'ok');

  // stage 与应用同生命周期, 隐藏舞台时仍保留系统事件连接.
  useEffect(() => mountSystemEvents({ ownsConnection: true }), []);

  useEffect(() => {
    const unlistenPreview = tauriBridge.listenLive2dPreview((command) => {
      const stage = activeStage.current;
      if (!stage) {
        return;
      }
      if (command.type === 'expression') {
        stage.handle.setExpression(command.expression);
        setSelectedExpression(command.expression);
      } else if (command.type === 'motion') {
        stage.handle.playMotion(command.group, command.index);
      } else {
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

  // stage 持有应用服务器健康轮询.
  useEffect(() => {
    const stop = useServerStore.getState().startPolling();
    return stop;
  }, []);

  const retryPresentation = (): void => setPresentationChangeCount(count => count + 1);
  const hasPresentation = stagePresentation !== null
    && stagePresentation.characterName === activeCharacterName;
  let setupFeedback: React.JSX.Element | null = null;
  if (presentationError?.characterName === activeCharacterName) {
    setupFeedback = <StageFailure
      title="角色读取失败"
      message={presentationError.message}
      onRetry={retryPresentation}
    />;
  } else if (!hasPresentation) {
    if (serverStatus.kind === 'error') {
      setupFeedback = <StageFailure
        title="无法连接 Ema"
        message={serverStatus.reason}
        onRetry={() => { void useServerStore.getState().refresh(); }}
      />;
    } else if (serverStatus.kind !== 'ok') {
      setupFeedback = <StageLoading message="正在启动 Ema..." />;
    } else if (charactersError) {
      setupFeedback = <StageFailure
        title="角色列表读取失败"
        message={charactersError}
        onRetry={() => { void useCharacterStore.getState().load(); }}
      />;
    } else if (!charactersLoaded || charactersLoading || activeCharacterName) {
      setupFeedback = <StageLoading message="正在加载角色..." />;
    }
  }

  return (
    <>

      {/* 拖拽层位于所有内容下方, 可交互组件必须显式关闭 Tauri 拖拽. */}
      <div style={dragLayerStyle} data-tauri-drag-region />

      <GlowBorder />

      {hasPresentation && (
        <CharacterStage
          targetCharacterName={activeCharacterName}
          presentation={stagePresentation}
          onStageChanged={handleStageChanged}
          onExpressionChanged={setSelectedExpression}
          onRetryPresentation={retryPresentation}
        />
      )}
      {setupFeedback && <div className="ema-character-stage">{setupFeedback}</div>}

      <SpeechBubble />

      <FloatingDock
        suspended={stageControlsHidden}
        expressionAvailable={expressionAvailable}
        expressions={expressions}
        selectedExpression={selectedExpression}
        onSelectExpression={(expression) => {
          activeStage.current?.handle.setExpression(expression);
          setSelectedExpression(expression);
        }}
      />

      <ServerBadge status={serverStatus} />

      {/* stage 只显示非阻塞授权提示, AskUser 由 main 的 Session 队列处理. */}
      <PermissionToastLayer />
    </>
  );
}

function GlowBorder(): React.JSX.Element {
  return <div className="ema-pet-glow-border" />;
}

const dragLayerStyle: React.CSSProperties = {
  position:      'fixed',
  inset:         0,
  zIndex:        0,
  // 拖拽区必须接收鼠标事件, 因此不能设置 pointer-events:none.
};

function ServerBadge({ status }: { status: ServerStatus }): React.JSX.Element {
  let detail: string;
  switch (status.kind) {
    case 'ok':
      detail = `服务器 @ port ${status.port}`;
      break;
    case 'pending':
      detail = '等待服务器启动...';
      break;
    case 'error':
      detail = `服务器错误: ${status.reason}`;
      break;
    default:
      detail = '服务器状态未知';
  }

  return (
    <Tooltip content={detail} side="right" sideOffset={8}>
      <button
        type="button"
        data-pet-interactive
        className="ema-server-status"
        data-status={status.kind}
        aria-label={detail}
      >
        <span className="ema-server-status-dot" />
      </button>
    </Tooltip>
  );
}

