import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type JSX,
  type SetStateAction,
} from 'react';
import type {
  CharacterIllustrationStageEntry,
  CharacterLive2dStageEntry,
  CharacterStagePresentation,
} from '@ema-agent/characters';
import {
  Live2DStage,
  type Live2DStageHandle,
  type Live2DStageReadyInfo,
} from '@ema-agent/live2d-react';
import { Button, Callout, Spinner } from '@ema-agent/ui';
import { charactersApi } from '../api/characters.js';
import { fetchServerObjectUrl } from '../api/serverFileUrl.js';
import { tauriBridge } from '../lib/tauri/tauriBridge.js';

export interface CharacterStageProps {
  targetCharacterName: string | null;
  presentation: CharacterStagePresentation | null;
  onStageChanged?: (stage: ActiveLive2DStage | null) => void;
  onExpressionChanged?: (expression: string | null) => void;
  onRetryPresentation?: () => void;
}

export interface ActiveLive2DStage {
  handle: Live2DStageHandle;
  hasExpressions: boolean;
  expressions: readonly string[];
}

interface LoadedLive2dArchive {
  readonly characterName: string;
  readonly live2dName: string;
  readonly archive: Blob;
}

interface Live2dFailure {
  readonly characterName: string;
  readonly live2dName: string;
  readonly message: string;
}

export function CharacterStage({
  targetCharacterName,
  presentation,
  onStageChanged,
  onExpressionChanged,
  onRetryPresentation,
}: CharacterStageProps): JSX.Element {
  const [loadedLive2dArchive, setLoadedLive2dArchive] = useState<LoadedLive2dArchive | null>(null);
  const [readyArchive, setReadyArchive] = useState<Blob | null>(null);
  const [failure, setFailure] = useState<Live2dFailure | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const showsLive2d = presentation?.status === 'live2d'
    && presentation.characterName === targetCharacterName;
  const live2dCharacterName = showsLive2d ? presentation.characterName : null;
  const live2dName = showsLive2d ? presentation.resource.name : null;

  useEffect(() => {
    setFailure(null);
    setReadyArchive(null);
    onStageChanged?.(null);
    if (!live2dCharacterName || !live2dName) {
      setLoadedLive2dArchive(null);
      return;
    }

    let cancelled = false;
    setLoadedLive2dArchive(current => (
      current?.characterName === live2dCharacterName && current.live2dName === live2dName
        ? current
        : null
    ));
    void charactersApi.live2dArchive(live2dCharacterName, live2dName)
      .then((archive) => {
        if (!cancelled) {
          setLoadedLive2dArchive({
            characterName: live2dCharacterName,
            live2dName,
            archive,
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.error('[stage] Live2D 模型包读取失败', live2dCharacterName, live2dName, error);
          onStageChanged?.(null);
          setFailure({
            characterName: live2dCharacterName,
            live2dName,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      cancelled = true;
      onStageChanged?.(null);
    };
  }, [live2dCharacterName, live2dName, onStageChanged, retryCount]);

  const ready = useCallback((
    handle: Live2DStageHandle,
    info: Live2DStageReadyInfo,
  ): void => {
    if (!loadedLive2dArchive) return;
    setReadyArchive(loadedLive2dArchive.archive);
    onStageChanged?.({
      handle,
      hasExpressions: info.hasExpressions,
      expressions: info.expressions,
    });
  }, [loadedLive2dArchive, onStageChanged]);

  const live2dMatchesTarget = showsLive2d
    && loadedLive2dArchive?.characterName === presentation.characterName
    && loadedLive2dArchive.live2dName === presentation.resource.name;
  const currentFailure = failure?.characterName === live2dCharacterName
    && failure?.live2dName === live2dName
    ? failure
    : null;
  const illustration = presentation?.status === 'illustration'
    && presentation.characterName === targetCharacterName
    ? presentation
    : null;
  const unavailable = presentation?.status === 'unavailable'
    && presentation.characterName === targetCharacterName
    ? presentation
    : null;
  const modelReady = live2dMatchesTarget && readyArchive === loadedLive2dArchive?.archive;

  return (
    <div className="ema-character-stage" data-tauri-drag-region={false}>
      {showsLive2d && !currentFailure && (
        <StageLoading message="正在加载角色..." visible={!modelReady} />
      )}

      {live2dMatchesTarget && loadedLive2dArchive && (
        <Live2dResource
          key={JSON.stringify([live2dCharacterName, live2dName, retryCount])}
          archive={loadedLive2dArchive.archive}
          resource={presentation.resource}
          ready={modelReady}
          onReady={ready}
          onExpressionChanged={onExpressionChanged}
          onError={(error) => {
            console.error('[stage] Live2D 模型加载失败', presentation.resource.name, error);
            onStageChanged?.(null);
            setFailure({
              characterName: presentation.characterName,
              live2dName: presentation.resource.name,
              message: error.message,
            });
          }}
        />
      )}

      {currentFailure && (
        <StageFailure
          title="Live2D 加载失败"
          message={currentFailure.message}
          onRetry={() => {
            setFailure(null);
            setLoadedLive2dArchive(null);
            setReadyArchive(null);
            setRetryCount(count => count + 1);
          }}
        />
      )}

      {unavailable && (
        <StageFailure
          title="角色资源不可用"
          message={UNAVAILABLE_REASON[unavailable.reason]}
          onRetry={onRetryPresentation}
        />
      )}

      {illustration && (
        <IllustrationResource
          key={illustration.characterName}
          presentation={illustration}
        />
      )}
    </div>
  );
}

const UNAVAILABLE_REASON = {
  primary_resource_missing: '尚未选择舞台资源. 请在角色卡中选择 Live2D 模型或插图.',
  resource_file_missing: '舞台资源文件不存在. 请在角色卡中重新导入或选择其他资源.',
  resource_invalid: '舞台资源无法读取. 请在角色卡中检查资源或重新导入.',
} as const;

export function StageLoading({ message, visible = true }: {
  message: string;
  visible?: boolean;
}): JSX.Element {
  return (
    <div
      className="ema-character-stage-loading"
      data-visible={visible}
      role="status"
      aria-hidden={!visible}
    >
      <div className="ema-character-stage-loading-panel">
        <Spinner size="sm" label={message} />
        <span>{message}</span>
      </div>
    </div>
  );
}

export function StageFailure({ title, message, onRetry }: {
  title: string;
  message: string;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div className="ema-character-stage-error" role="alert" data-pet-interactive>
      <Callout variant="danger" title={title}>
        <p className="ema-character-stage-error-message">{message}</p>
        {onRetry && (
          <Button size="sm" className="mt-3" onClick={onRetry}>
            重新加载
          </Button>
        )}
      </Callout>
    </div>
  );
}

function Live2dResource({
  archive,
  resource,
  ready,
  onReady,
  onExpressionChanged,
  onError,
}: {
  archive: Blob;
  resource: CharacterLive2dStageEntry;
  ready: boolean;
  onReady(handle: Live2DStageHandle, info: Live2DStageReadyInfo): void;
  onExpressionChanged?: (expression: string | null) => void;
  onError(error: Error): void;
}): JSX.Element {
  const handleRef = useRef<Live2DStageHandle | null>(null);
  const { emotionMap, motionMap } = resource;

  useEffect(() => {
    if (!tauriBridge.isTauri()) return;
    const unlistenPointer = tauriBridge.listenPetPointer((event) => {
      if (event.type === 'position') {
        handleRef.current?.setPointerPosition(event.clientX, event.clientY);
      }
    });
    return () => {
      void unlistenPointer.then(stop => stop());
    };
  }, []);

  useEffect(() => {
    const unlistenEmotion = tauriBridge.listenStageEmotion((emotion) => {
      const target = emotionMap[emotion];
      const expression = target?.expression ?? null;
      handleRef.current?.setExpression(expression);
      onExpressionChanged?.(expression);
    });
    const unlistenMotion = tauriBridge.listenStageMotion((motion) => {
      const target = motionMap[motion];
      if (target) handleRef.current?.playMotion(target.group, target.index);
    });
    const unlistenLipSync = tauriBridge.listenStageLipSync((speaking, mouthOpen) => {
      handleRef.current?.setLipSync(speaking, mouthOpen);
    });

    return () => {
      void unlistenEmotion.then(stop => stop());
      void unlistenMotion.then(stop => stop());
      void unlistenLipSync.then(stop => stop());
    };
  }, [onExpressionChanged, emotionMap, motionMap]);

  return (
    <div className="ema-character-stage-resource" data-state={ready ? 'active' : 'loading'}>
      <Live2DStage
        ref={handleRef}
        modelArchive={archive}
        stageScale={resource.stageScale}
        stageOffsetX={resource.stageOffsetX}
        stageOffsetY={resource.stageOffsetY}
        pointerSource={tauriBridge.isTauri() ? 'host' : 'window'}
        onReady={(info) => {
          if (handleRef.current) onReady(handleRef.current, info);
        }}
        onError={onError}
      />
    </div>
  );
}

function IllustrationResource({
  presentation,
}: {
  presentation: Extract<CharacterStagePresentation, { status: 'illustration' }>;
}): JSX.Element {
  const [desired, setDesired] = useState(presentation.resource);
  const [displayed, setDisplayed] = useState<LoadedIllustration | null>(null);
  const [outgoing, setOutgoing] = useState<LoadedIllustration | null>(null);
  const displayedRef = useRef<LoadedIllustration | null>(null);
  const outgoingRef = useRef<LoadedIllustration | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDesired(presentation.resource);
  }, [presentation]);

  // 相同情绪也重新抽取,让一组同语义立绘产生 Galgame 式变化.
  useEffect(() => {
    return listenForIllustrationEmotion(presentation, setDesired);
  }, [presentation]);

  // 新图完成浏览器解码后再替换旧图,避免认证读取和图片解码期间舞台闪空.
  useEffect(() => {
    let cancelled = false;
    void fetchServerObjectUrl(charactersApi.illustrationFileUrl(
      presentation.characterName,
      desired.name,
    )).then(async (url) => {
      if (!url) return;
      try {
        await loadImage(url);
      } catch {
        URL.revokeObjectURL(url);
        return;
      }
      if (cancelled) {
        URL.revokeObjectURL(url);
        return;
      }

      const next = { resource: desired, url };
      const previous = displayedRef.current;
      displayedRef.current = next;
      setDisplayed(next);

      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      if (outgoingRef.current) URL.revokeObjectURL(outgoingRef.current.url);
      outgoingRef.current = previous;
      setOutgoing(previous);
      exitTimerRef.current = setTimeout(() => {
        if (outgoingRef.current) URL.revokeObjectURL(outgoingRef.current.url);
        outgoingRef.current = null;
        setOutgoing(null);
        exitTimerRef.current = null;
      }, 300);
    });

    return () => {
      cancelled = true;
    };
  }, [desired, presentation.characterName]);

  useEffect(() => () => {
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    if (displayedRef.current) URL.revokeObjectURL(displayedRef.current.url);
    if (outgoingRef.current) URL.revokeObjectURL(outgoingRef.current.url);
  }, []);

  return (
    <div className="ema-character-stage-resource" data-state="active">
      {outgoing && <IllustrationLayer loaded={outgoing} state="outgoing" />}
      {displayed && <IllustrationLayer loaded={displayed} state="active" />}
    </div>
  );
}

interface LoadedIllustration {
  readonly resource: CharacterIllustrationStageEntry;
  readonly url: string;
}

function IllustrationLayer({
  loaded,
  state,
}: {
  loaded: LoadedIllustration;
  state: 'active' | 'outgoing';
}): JSX.Element {
  return (
    <div
      className="ema-character-stage-illustration-layer"
      data-state={state}
      style={illustrationTransform(loaded.resource)}
    >
      <img
        src={loaded.url}
        alt={loaded.resource.displayName}
        className="ema-character-stage-portrait"
        draggable={false}
      />
    </div>
  );
}

function listenForIllustrationEmotion(
  presentation: Extract<CharacterStagePresentation, { status: 'illustration' }>,
  setResource: Dispatch<SetStateAction<CharacterIllustrationStageEntry>>,
): () => void {
  let disposed = false;
  const unlisten = tauriBridge.listenStageEmotion((emotion) => {
    const pool = presentation.expressions[emotion];
    if (!pool?.length) return;
    setResource((current) => {
      const choices = pool.length > 1
        ? pool.filter(candidate => candidate.name !== current.name)
        : pool;
      return choices[Math.floor(Math.random() * choices.length)] ?? current;
    });
  });

  return () => {
    disposed = true;
    void unlisten.then((stop) => {
      if (disposed) stop();
    });
  };
}

function loadImage(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('立绘解码失败'));
    image.src = url;
  });
}

function illustrationTransform(resource: CharacterIllustrationStageEntry): React.CSSProperties {
  return {
    transform: `translate(${resource.stageOffsetX * 100}%, ${resource.stageOffsetY * 100}%) scale(${resource.stageScale})`,
  };
}
